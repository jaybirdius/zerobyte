import { and, eq } from "drizzle-orm";
import { BadRequestError, NotFoundError } from "http-errors-enhanced";
import { db } from "../../db/db";
import { volumeGroupsTable, volumesTable } from "../../db/schema";
import { getOrganizationId } from "~/server/core/request-context";
import type { ShortId } from "~/server/utils/branded";

const listGroups = async () => {
	const organizationId = getOrganizationId();
	return await db.query.volumeGroupsTable.findMany({
		where: { organizationId },
		orderBy: { sortOrder: "asc", name: "asc" },
	});
};

const createGroup = async (name: string) => {
	const organizationId = getOrganizationId();
	const trimmedName = name?.trim();

	if (!trimmedName || trimmedName.length === 0) {
		throw new BadRequestError("Group name cannot be empty");
	}

	const [created] = await db
		.insert(volumeGroupsTable)
		.values({
			name: trimmedName,
			organizationId,
		})
		.returning();

	return created;
};

const updateGroup = async (id: number, data: { name?: string; sortOrder?: number }) => {
	const organizationId = getOrganizationId();

	const updates: Record<string, unknown> = {};
	if (data.name !== undefined) updates.name = data.name.trim();
	if (data.sortOrder !== undefined) updates.sortOrder = data.sortOrder;

	const [updated] = await db
		.update(volumeGroupsTable)
		.set(updates)
		.where(and(eq(volumeGroupsTable.id, id), eq(volumeGroupsTable.organizationId, organizationId)))
		.returning();

	if (!updated) {
		throw new NotFoundError("Group not found");
	}

	return updated;
};

const deleteGroup = async (id: number) => {
	const organizationId = getOrganizationId();

	// Unassign all volumes from this group first
	await db
		.update(volumesTable)
		.set({ groupId: null })
		.where(and(eq(volumesTable.groupId, id), eq(volumesTable.organizationId, organizationId)));

	await db
		.delete(volumeGroupsTable)
		.where(and(eq(volumeGroupsTable.id, id), eq(volumeGroupsTable.organizationId, organizationId)));
};

const assignVolumeToGroup = async (shortId: ShortId, groupId: number | null) => {
	const organizationId = getOrganizationId();

	const volume = await db.query.volumesTable.findFirst({
		where: {
			AND: [{ shortId: { eq: shortId } }, { organizationId }],
		},
	});

	if (!volume) {
		throw new NotFoundError("Volume not found");
	}

	// Validate group exists if groupId is provided
	if (groupId !== null) {
		const group = await db.query.volumeGroupsTable.findFirst({
			where: {
				AND: [{ id: { eq: groupId } }, { organizationId }],
			},
		});
		if (!group) {
			throw new NotFoundError("Group not found");
		}
	}

	await db
		.update(volumesTable)
		.set({ groupId })
		.where(and(eq(volumesTable.id, volume.id), eq(volumesTable.organizationId, organizationId)));
};

export const volumeGroupService = {
	listGroups,
	createGroup,
	updateGroup,
	deleteGroup,
	assignVolumeToGroup,
};
