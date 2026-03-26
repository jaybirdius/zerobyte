import { VOLUME_MOUNT_BASE } from "../../core/constants";
import type { Volume } from "../../db/schema";

export const getVolumePath = (volume: Volume) => {
	if (volume.config.backend === "directory") {
		return volume.config.path;
	}

	if (volume.config.backend === "docker") {
		// Docker volumes are accessed via their host mountpoint
		// which is mounted into the container at /var/lib/docker/volumes
		return `/var/lib/docker/volumes/${volume.config.volumeName}/_data`;
	}

	return `${VOLUME_MOUNT_BASE}/${volume.shortId}/_data`;
};
