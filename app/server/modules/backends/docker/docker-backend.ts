import * as fs from "node:fs/promises";
import { toMessage } from "../../../utils/errors";
import { logger } from "@zerobyte/core/node";
import type { VolumeBackend } from "../backend";
import { BACKEND_STATUS, type BackendConfig } from "~/schemas/volumes";

/**
 * Resolves a Docker volume name to its host mount path.
 * Queries the Docker socket to find the volume's Mountpoint.
 */
const resolveDockerVolumePath = async (volumeName: string): Promise<string> => {
	const socketPath = process.env.DOCKER_HOST || "/var/run/docker.sock";
	const http = await import("node:http");

	return new Promise((resolve, reject) => {
		const options = {
			socketPath,
			path: `/v1.45/volumes/${encodeURIComponent(volumeName)}`,
			method: "GET",
		};

		const req = http.request(options, (res) => {
			let data = "";
			res.on("data", (chunk: Buffer) => {
				data += chunk.toString();
			});
			res.on("end", () => {
				try {
					const volume = JSON.parse(data);
					if (volume.Mountpoint) {
						resolve(volume.Mountpoint);
					} else if (volume.message) {
						reject(new Error(volume.message));
					} else {
						reject(new Error("Docker volume has no Mountpoint"));
					}
				} catch (e) {
					reject(new Error(`Failed to parse Docker API response: ${data}`));
				}
			});
		});

		req.on("error", (e) => {
			reject(new Error(`Failed to connect to Docker socket: ${e.message}`));
		});

		req.end();
	});
};

const mount = async (config: BackendConfig, _volumePath: string) => {
	if (config.backend !== "docker") {
		return { status: BACKEND_STATUS.error, error: "Invalid backend type" };
	}

	logger.info("Mounting Docker volume:", config.volumeName);

	try {
		const mountPath = await resolveDockerVolumePath(config.volumeName);
		await fs.access(mountPath);
		const stats = await fs.stat(mountPath);

		if (!stats.isDirectory()) {
			return { status: BACKEND_STATUS.error, error: "Docker volume mount path is not a directory" };
		}

		return { status: BACKEND_STATUS.mounted };
	} catch (error) {
		logger.error("Failed to mount Docker volume:", error);
		return { status: BACKEND_STATUS.error, error: toMessage(error) };
	}
};

const unmount = async () => {
	logger.info("Cannot unmount Docker volume (managed by Docker daemon).");
	return { status: BACKEND_STATUS.unmounted };
};

const checkHealth = async (config: BackendConfig) => {
	if (config.backend !== "docker") {
		return { status: BACKEND_STATUS.error, error: "Invalid backend type" };
	}

	try {
		const mountPath = await resolveDockerVolumePath(config.volumeName);
		await fs.access(mountPath);
		return { status: BACKEND_STATUS.mounted };
	} catch (error) {
		logger.error("Docker volume health check failed:", error);
		return { status: BACKEND_STATUS.error, error: toMessage(error) };
	}
};

export const makeDockerBackend = (config: BackendConfig, volumePath: string): VolumeBackend => ({
	mount: () => mount(config, volumePath),
	unmount,
	checkHealth: () => checkHealth(config),
});
