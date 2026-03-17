import { NotFoundError, BadRequestError, ConflictError } from "http-errors-enhanced";
import type { BackupSchedule, Volume, Repository } from "../../db/schema";
import { restic } from "../../core/restic";
import { resticDeps } from "../../core/restic";
import { logger } from "@zerobyte/core/node";
import { cache, cacheKeys } from "../../utils/cache";
import { getVolumePath } from "../volumes/helpers";
import { toErrorDetails, toMessage } from "../../utils/errors";
import { serverEvents } from "../../core/events";
import { notificationsService } from "../notifications/notifications.service";
import { repoMutex } from "../../core/repository-mutex";
import { repositoriesService } from "../repositories/repositories.service";
import { getOrganizationId } from "~/server/core/request-context";
import { scheduleQueries, mirrorQueries, repositoryQueries } from "./backups.queries";
import { calculateNextRun, createBackupOptions } from "./backup.helpers";
import type { ResticBackupOutputDto } from "@zerobyte/core/restic";
import type { BackupProgressEventDto } from "~/schemas/events-dto";
import { decryptRepositoryConfig } from "../repositories/repository-config-secrets";
import { agentManager } from "../agents/agents-manager";
import type {
	BackupCancelledPayload,
	BackupCompletedPayload,
	BackupFailedPayload,
	BackupProgressPayload,
	BackupRunPayload,
	BackupStartedPayload,
} from "@zerobyte/contracts/agent-protocol";

const LOCAL_AGENT_ID = "local";

type RunningBackup = {
	jobId: string;
	context: BackupContext;
	resolve: () => void;
	reject: (error: unknown) => void;
};

type AgentBackupEvent<TPayload> = {
	agentId: string;
	agentName: string;
	payload: TPayload;
};

const runningBackups = new Map<number, RunningBackup>();
const runningBackupsByJobId = new Map<string, number>();

export const getBackupProgress = (scheduleId: number): BackupProgressEventDto | undefined =>
	cache.get<BackupProgressEventDto>(cacheKeys.backup.progress(scheduleId));

interface BackupContext {
	schedule: BackupSchedule;
	volume: Volume;
	repository: Repository;
	organizationId: string;
}
type ValidationSuccess = {
	type: "success";
	context: BackupContext;
};
type ValidationFailure = {
	type: "failure";
	error: Error;
	partialContext?: Partial<BackupContext>;
};
type ValidationSkipped = {
	type: "skipped";
	reason: string;
};
type ValidationResult = ValidationSuccess | ValidationFailure | ValidationSkipped;

const validateBackupExecution = async (scheduleId: number, manual = false): Promise<ValidationResult> => {
	const organizationId = getOrganizationId();
	const result = await scheduleQueries.findById(scheduleId, organizationId);

	if (!result) {
		return { type: "failure", error: new NotFoundError("Backup schedule not found") };
	}

	const { volume, repository, ...schedule } = result;

	if (!schedule) {
		return { type: "failure", error: new NotFoundError("Backup schedule not found") };
	}

	if (!schedule.enabled && !manual) {
		logger.info(`Backup schedule ${scheduleId} is disabled. Skipping execution.`);
		return { type: "skipped", reason: "Backup schedule is disabled" };
	}

	if (schedule.lastBackupStatus === "in_progress") {
		logger.info(`Backup schedule ${scheduleId} is already in progress. Skipping execution.`);
		return { type: "skipped", reason: "Backup is already in progress" };
	}

	if (!volume) {
		return { type: "failure", error: new NotFoundError("Volume not found"), partialContext: { schedule } };
	}

	if (!repository) {
		return { type: "failure", error: new NotFoundError("Repository not found"), partialContext: { schedule, volume } };
	}

	if (volume.status !== "mounted") {
		return {
			type: "failure",
			error: new BadRequestError("Volume is not mounted"),
			partialContext: { schedule, volume, repository },
		};
	}

	return {
		type: "success",
		context: { schedule, volume, repository, organizationId },
	};
};

const emitBackupStarted = (ctx: BackupContext, scheduleId: number) => {
	logger.info(
		`Starting backup ${ctx.schedule.name} for volume ${ctx.volume.name} to repository ${ctx.repository.name}`,
	);

	serverEvents.emit("backup:started", {
		organizationId: ctx.organizationId,
		scheduleId: ctx.schedule.shortId,
		volumeName: ctx.volume.name,
		repositoryName: ctx.repository.name,
	});

	notificationsService
		.sendBackupNotification(scheduleId, "start", {
			volumeName: ctx.volume.name,
			repositoryName: ctx.repository.name,
			scheduleName: ctx.schedule.name,
		})
		.catch((error) => {
			logger.error(`Failed to send backup start notification: ${toMessage(error)}`);
		});
};

const buildAgentBackupPayload = async (ctx: BackupContext, jobId: string): Promise<BackupRunPayload> => {
	const sourcePath = getVolumePath(ctx.volume);
	const { signal: _ignoredSignal, ...options } = createBackupOptions(
		ctx.schedule,
		sourcePath,
		new AbortController().signal,
	);
	const repositoryConfig = await decryptRepositoryConfig(ctx.repository.config);
	const encryptedResticPassword = await resticDeps.getOrganizationResticPassword(ctx.organizationId);
	const resticPassword = await resticDeps.resolveSecret(encryptedResticPassword);

	return {
		jobId,
		scheduleId: ctx.schedule.shortId,
		organizationId: ctx.organizationId,
		sourcePath,
		repositoryConfig,
		options: {
			...options,
			compressionMode: ctx.repository.compressionMode ?? "auto",
		},
		runtime: {
			password: resticPassword,
			cacheDir: resticDeps.resticCacheDir,
			passFile: resticDeps.resticPassFile,
			defaultExcludes: resticDeps.defaultExcludes,
			hostname: resticDeps.hostname,
		},
	};
};

const getRunningBackupByJobId = (jobId: string) => {
	const scheduleId = runningBackupsByJobId.get(jobId);
	if (scheduleId === undefined) {
		return null;
	}

	const running = runningBackups.get(scheduleId);
	if (!running || running.jobId !== jobId) {
		runningBackupsByJobId.delete(jobId);
		return null;
	}

	return { scheduleId, running };
};

const clearRunningBackup = (scheduleId: number, jobId: string) => {
	runningBackups.delete(scheduleId);
	runningBackupsByJobId.delete(jobId);
	cache.del(cacheKeys.backup.progress(scheduleId));
};

const updateBackupProgress = (ctx: BackupContext, progress: BackupProgressPayload["progress"]) => {
	const progressEvent = {
		scheduleId: ctx.schedule.shortId,
		volumeName: ctx.volume.name,
		repositoryName: ctx.repository.name,
		...progress,
	};

	cache.set(cacheKeys.backup.progress(ctx.schedule.id), progressEvent, 60 * 60);

	serverEvents.emit("backup:progress", {
		organizationId: ctx.organizationId,
		...progressEvent,
	});
};

const finalizeSuccessfulBackup = async (
	ctx: BackupContext,
	scheduleId: number,
	exitCode: number,
	result: ResticBackupOutputDto | null,
	warningDetails: string | null,
) => {
	const finalStatus = exitCode === 0 ? "success" : "warning";

	if (ctx.schedule.retentionPolicy) {
		void runForget(scheduleId, undefined, ctx.organizationId).catch((error) => {
			logger.error(`Failed to run retention policy for schedule ${scheduleId}: ${toMessage(error)}`);
		});
	}

	void copyToMirrors(scheduleId, ctx.repository, ctx.schedule.retentionPolicy, ctx.organizationId).catch((error) => {
		logger.error(`Background mirror copy failed for schedule ${scheduleId}: ${toMessage(error)}`);
	});

	cache.delByPrefix(cacheKeys.repository.all(ctx.repository.id));

	void repositoriesService.refreshRepositoryStats(ctx.repository.shortId).catch((error) => {
		logger.error(
			`Background repository stats refresh failed for schedule ${scheduleId} (${ctx.repository.shortId}): ${toMessage(error)}`,
		);
	});

	const nextBackupAt = calculateNextRun(ctx.schedule.cronExpression);
	await scheduleQueries.updateStatus(scheduleId, ctx.organizationId, {
		lastBackupAt: Date.now(),
		lastBackupStatus: finalStatus,
		lastBackupError: finalStatus === "warning" ? warningDetails : null,
		nextBackupAt,
	});

	if (finalStatus === "warning") {
		logger.warn(
			`Backup ${ctx.schedule.name} completed with warnings for volume ${ctx.volume.name} to repository ${ctx.repository.name}`,
		);
	} else {
		logger.info(
			`Backup ${ctx.schedule.name} completed successfully for volume ${ctx.volume.name} to repository ${ctx.repository.name}`,
		);
	}

	serverEvents.emit("backup:completed", {
		organizationId: ctx.organizationId,
		scheduleId: ctx.schedule.shortId,
		volumeName: ctx.volume.name,
		repositoryName: ctx.repository.name,
		status: finalStatus,
		summary: result ?? undefined,
	});

	notificationsService
		.sendBackupNotification(scheduleId, finalStatus, {
			volumeName: ctx.volume.name,
			repositoryName: ctx.repository.name,
			scheduleName: ctx.schedule.name,
			summary: result ?? undefined,
		})
		.catch((error) => {
			logger.error(`Failed to send backup success notification: ${toMessage(error)}`);
		});
};

const handleValidationResult = async (scheduleId: number, result: ValidationFailure | ValidationSkipped) => {
	const organizationId = getOrganizationId();

	if (result.type === "skipped") {
		logger.info(`Backup execution for schedule ${scheduleId} was skipped: ${result.reason}`);
		return;
	}

	await handleBackupFailure(scheduleId, organizationId, result.error, result.partialContext);
};

const handleBackupFailure = async (
	scheduleId: number,
	organizationId: string,
	error: unknown,
	partialContext?: Partial<BackupContext>,
): Promise<void> => {
	const errorMessage = toMessage(error);
	const errorDetails = toErrorDetails(error);

	await scheduleQueries.updateStatus(scheduleId, organizationId, {
		lastBackupAt: Date.now(),
		lastBackupStatus: "error",
		lastBackupError: errorDetails,
	});

	if (partialContext?.schedule && partialContext?.volume && partialContext?.repository) {
		const ctx = partialContext as BackupContext;

		logger.error(
			`Backup ${ctx.schedule.name} failed for volume ${ctx.volume.name} to repository ${ctx.repository.name}: ${errorMessage}`,
		);

		serverEvents.emit("backup:completed", {
			organizationId,
			scheduleId: ctx.schedule.shortId,
			volumeName: ctx.volume.name,
			repositoryName: ctx.repository.name,
			status: "error",
		});

		notificationsService
			.sendBackupNotification(scheduleId, "failure", {
				volumeName: ctx.volume.name,
				repositoryName: ctx.repository.name,
				scheduleName: ctx.schedule.name,
				error: errorDetails,
			})
			.catch((notifError) => {
				logger.error(`Failed to send backup failure notification: ${toMessage(notifError)}`);
			});
	}
};

const handleAgentBackupStarted = ({ payload, agentId }: AgentBackupEvent<BackupStartedPayload>) => {
	const running = getRunningBackupByJobId(payload.jobId);
	if (!running) {
		logger.warn(`Received backup.started for unknown job ${payload.jobId} from agent ${agentId}`);
		return;
	}

	if (running.running.context.schedule.shortId !== payload.scheduleId) {
		logger.warn(
			`Ignoring backup.started for job ${payload.jobId} due to schedule mismatch ${payload.scheduleId} from agent ${agentId}`,
		);
	}
};

const handleAgentBackupProgress = ({ payload, agentId }: AgentBackupEvent<BackupProgressPayload>) => {
	const running = getRunningBackupByJobId(payload.jobId);
	if (!running) {
		logger.warn(`Received backup.progress for unknown job ${payload.jobId} from agent ${agentId}`);
		return;
	}

	if (running.running.context.schedule.shortId !== payload.scheduleId) {
		logger.warn(
			`Ignoring backup.progress for job ${payload.jobId} due to schedule mismatch ${payload.scheduleId} from agent ${agentId}`,
		);
		return;
	}

	updateBackupProgress(running.running.context, payload.progress);
};

const handleAgentBackupCompleted = async ({ payload, agentId }: AgentBackupEvent<BackupCompletedPayload>) => {
	const running = getRunningBackupByJobId(payload.jobId);
	if (!running) {
		logger.warn(`Received backup.completed for unknown job ${payload.jobId} from agent ${agentId}`);
		return;
	}

	if (running.running.context.schedule.shortId !== payload.scheduleId) {
		logger.warn(
			`Ignoring backup.completed for job ${payload.jobId} due to schedule mismatch ${payload.scheduleId} from agent ${agentId}`,
		);
		return;
	}

	try {
		await finalizeSuccessfulBackup(
			running.running.context,
			running.scheduleId,
			payload.exitCode,
			payload.result,
			payload.warningDetails ?? null,
		);
		running.running.resolve();
	} catch (error) {
		await handleBackupFailure(
			running.scheduleId,
			running.running.context.organizationId,
			error,
			running.running.context,
		);
		running.running.reject(error);
	} finally {
		clearRunningBackup(running.scheduleId, payload.jobId);
	}
};

const handleAgentBackupFailed = async ({ payload, agentId }: AgentBackupEvent<BackupFailedPayload>) => {
	const running = getRunningBackupByJobId(payload.jobId);
	if (!running) {
		logger.warn(`Received backup.failed for unknown job ${payload.jobId} from agent ${agentId}`);
		return;
	}

	if (running.running.context.schedule.shortId !== payload.scheduleId) {
		logger.warn(
			`Ignoring backup.failed for job ${payload.jobId} due to schedule mismatch ${payload.scheduleId} from agent ${agentId}`,
		);
		return;
	}

	try {
		await handleBackupFailure(
			running.scheduleId,
			running.running.context.organizationId,
			payload.errorDetails ?? payload.error,
			running.running.context,
		);
		running.running.reject(new Error(payload.errorDetails ?? payload.error));
	} finally {
		clearRunningBackup(running.scheduleId, payload.jobId);
	}
};

const handleAgentBackupCancelled = async ({ payload, agentId }: AgentBackupEvent<BackupCancelledPayload>) => {
	const running = getRunningBackupByJobId(payload.jobId);
	if (!running) {
		logger.warn(`Received backup.cancelled for unknown job ${payload.jobId} from agent ${agentId}`);
		return;
	}

	if (running.running.context.schedule.shortId !== payload.scheduleId) {
		logger.warn(
			`Ignoring backup.cancelled for job ${payload.jobId} due to schedule mismatch ${payload.scheduleId} from agent ${agentId}`,
		);
		return;
	}

	try {
		await scheduleQueries.updateStatus(running.scheduleId, running.running.context.organizationId, {
			lastBackupAt: Date.now(),
			lastBackupStatus: "warning",
			lastBackupError: payload.message ?? "Backup was stopped by the user",
		});
		running.running.resolve();
	} catch (error) {
		running.running.reject(error);
	} finally {
		clearRunningBackup(running.scheduleId, payload.jobId);
	}
};

agentManager.setBackupEventHandlers({
	onBackupStarted: (event) => handleAgentBackupStarted(event),
	onBackupProgress: (event) => handleAgentBackupProgress(event),
	onBackupCompleted: (event) => {
		void handleAgentBackupCompleted(event).catch((error) => {
			logger.error(`Failed to handle backup.completed event: ${toMessage(error)}`);
		});
	},
	onBackupFailed: (event) => {
		void handleAgentBackupFailed(event).catch((error) => {
			logger.error(`Failed to handle backup.failed event: ${toMessage(error)}`);
		});
	},
	onBackupCancelled: (event) => {
		void handleAgentBackupCancelled(event).catch((error) => {
			logger.error(`Failed to handle backup.cancelled event: ${toMessage(error)}`);
		});
	},
});

const executeBackup = async (scheduleId: number, manual = false): Promise<void> => {
	const result = await validateBackupExecution(scheduleId, manual);

	if (result.type !== "success") {
		return handleValidationResult(scheduleId, result);
	}

	const { context: ctx } = result;
	cache.del(cacheKeys.backup.progress(scheduleId));
	emitBackupStarted(ctx, scheduleId);

	const nextBackupAt = calculateNextRun(ctx.schedule.cronExpression);

	await scheduleQueries.updateStatus(scheduleId, ctx.organizationId, {
		lastBackupStatus: "in_progress",
		lastBackupError: null,
		nextBackupAt,
	});

	const jobId = Bun.randomUUIDv7();
	const completion = new Promise<void>((resolve, reject) => {
		runningBackups.set(scheduleId, {
			jobId,
			context: ctx,
			resolve,
			reject,
		});
		runningBackupsByJobId.set(jobId, scheduleId);
	});

	try {
		const payload = await buildAgentBackupPayload(ctx, jobId);
		const dispatched = agentManager.sendBackup(LOCAL_AGENT_ID, payload);

		if (!dispatched) {
			clearRunningBackup(scheduleId, jobId);
			await handleBackupFailure(scheduleId, ctx.organizationId, new Error("Local backup agent is not connected"), ctx);
			return;
		}

		await completion;
	} catch (error) {
		if (runningBackups.get(scheduleId)?.jobId === jobId) {
			clearRunningBackup(scheduleId, jobId);
			await handleBackupFailure(scheduleId, ctx.organizationId, error, ctx);
		}
	}
};

const getSchedulesToExecute = async () => {
	const organizationId = getOrganizationId();
	return scheduleQueries.findExecutable(organizationId);
};

const stopBackup = async (scheduleId: number) => {
	const organizationId = getOrganizationId();
	const schedule = await scheduleQueries.findById(scheduleId, organizationId);

	if (!schedule) {
		throw new NotFoundError("Backup schedule not found");
	}

	try {
		const runningBackup = runningBackups.get(scheduleId);
		if (!runningBackup) {
			throw new ConflictError("No backup is currently running for this schedule");
		}

		logger.info(`Stopping backup for schedule ${scheduleId}`);
		agentManager.cancelBackup(LOCAL_AGENT_ID, {
			jobId: runningBackup.jobId,
			scheduleId: runningBackup.context.schedule.shortId,
		});
	} finally {
		await scheduleQueries.updateStatus(scheduleId, organizationId, {
			lastBackupStatus: "warning",
			lastBackupError: "Backup was stopped by the user",
		});
	}
};

const runForget = async (scheduleId: number, repositoryId?: string, organizationIdOverride?: string) => {
	const organizationId = organizationIdOverride ?? getOrganizationId();
	const schedule = await scheduleQueries.findById(scheduleId, organizationId);

	if (!schedule) {
		throw new NotFoundError("Backup schedule not found");
	}

	if (!schedule.retentionPolicy) {
		throw new BadRequestError("No retention policy configured for this schedule");
	}

	const repository = await repositoryQueries.findById(repositoryId ?? schedule.repositoryId, organizationId);

	if (!repository) {
		throw new NotFoundError("Repository not found");
	}

	logger.info(`running retention policy (forget) for schedule ${scheduleId}`);
	const releaseLock = await repoMutex.acquireExclusive(repository.id, `forget:${scheduleId}`);

	try {
		await restic.forget(repository.config, schedule.retentionPolicy, { tag: schedule.shortId, organizationId });
		cache.delByPrefix(cacheKeys.repository.all(repository.id));
	} finally {
		releaseLock();
	}

	logger.info(`Retention policy applied successfully for schedule ${scheduleId}`);
};

const copyToMirrors = async (
	scheduleId: number,
	sourceRepository: Repository,
	retentionPolicy: BackupSchedule["retentionPolicy"],
	organizationIdOverride?: string,
) => {
	const organizationId = organizationIdOverride ?? getOrganizationId();
	const schedule = await scheduleQueries.findById(scheduleId, organizationId);

	if (!schedule) {
		throw new NotFoundError("Backup schedule not found");
	}

	const mirrors = await mirrorQueries.findEnabledBySchedule(scheduleId);

	if (mirrors.length === 0) {
		return;
	}

	logger.info(`[Background] Copying snapshots to ${mirrors.length} mirror repositories for schedule ${scheduleId}`);

	for (const mirror of mirrors) {
		await copyToSingleMirror(scheduleId, schedule, sourceRepository, mirror, retentionPolicy, organizationId);
	}
};

const copyToSingleMirror = async (
	scheduleId: number,
	schedule: BackupSchedule,
	sourceRepository: Repository,
	mirror: {
		repositoryId: string;
		repository: Repository;
	},
	retentionPolicy: BackupSchedule["retentionPolicy"],
	organizationId: string,
) => {
	try {
		logger.info(`[Background] Copying to mirror repository: ${mirror.repository.name}`);

		serverEvents.emit("mirror:started", {
			organizationId,
			scheduleId: schedule.shortId,
			repositoryId: mirror.repository.shortId,
			repositoryName: mirror.repository.name,
		});

		await mirrorQueries.updateStatus(scheduleId, mirror.repositoryId, {
			lastCopyStatus: "in_progress",
			lastCopyError: null,
		});

		const releaseSource = await repoMutex.acquireShared(sourceRepository.id, `mirror_source:${scheduleId}`);
		const releaseMirror = await repoMutex.acquireShared(mirror.repository.id, `mirror:${scheduleId}`);

		try {
			await restic.copy(sourceRepository.config, mirror.repository.config, { tag: schedule.shortId, organizationId });
			cache.delByPrefix(cacheKeys.repository.all(mirror.repository.id));
		} finally {
			releaseSource();
			releaseMirror();
		}

		if (retentionPolicy) {
			void runForget(scheduleId, mirror.repository.id, organizationId).catch((error) => {
				logger.error(
					`Failed to run retention policy for mirror repository ${mirror.repository.name}: ${toMessage(error)}`,
				);
			});
		}

		await mirrorQueries.updateStatus(scheduleId, mirror.repositoryId, {
			lastCopyAt: Date.now(),
			lastCopyStatus: "success",
			lastCopyError: null,
		});

		logger.info(`[Background] Successfully copied to mirror repository: ${mirror.repository.name}`);

		serverEvents.emit("mirror:completed", {
			organizationId,
			scheduleId: schedule.shortId,
			repositoryId: mirror.repository.shortId,
			repositoryName: mirror.repository.name,
			status: "success",
		});
	} catch (error) {
		const errorMessage = toMessage(error);
		logger.error(`[Background] Failed to copy to mirror repository ${mirror.repository.name}: ${errorMessage}`);

		await mirrorQueries.updateStatus(scheduleId, mirror.repositoryId, {
			lastCopyAt: Date.now(),
			lastCopyStatus: "error",
			lastCopyError: errorMessage,
		});

		serverEvents.emit("mirror:completed", {
			organizationId,
			scheduleId: schedule.shortId,
			repositoryId: mirror.repository.shortId,
			repositoryName: mirror.repository.name,
			status: "error",
			error: errorMessage,
		});
	}
};

export const backupsExecutionService = {
	executeBackup,
	validateBackupExecution,
	getSchedulesToExecute,
	stopBackup,
	runForget,
	copyToMirrors,
	getBackupProgress,
};
