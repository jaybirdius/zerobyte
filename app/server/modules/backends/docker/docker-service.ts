import { logger } from "@zerobyte/core/node";

export type DockerVolumeInfo = {
	name: string;
	driver: string;
	mountpoint: string;
	labels: Record<string, string>;
	createdAt: string;
};

/**
 * Lists all Docker volumes via the Docker socket API.
 */
export const listDockerVolumes = async (): Promise<DockerVolumeInfo[]> => {
	const socketPath = process.env.DOCKER_HOST || "/var/run/docker.sock";
	const http = await import("node:http");

	return new Promise((resolve, reject) => {
		const options = {
			socketPath,
			path: "/v1.45/volumes",
			method: "GET",
		};

		const req = http.request(options, (res) => {
			let data = "";
			res.on("data", (chunk: Buffer) => {
				data += chunk.toString();
			});
			res.on("end", () => {
				try {
					const response = JSON.parse(data);
					const volumes = (response.Volumes || []).map((v: Record<string, unknown>) => ({
						name: v.Name as string,
						driver: v.Driver as string,
						mountpoint: v.Mountpoint as string,
						labels: (v.Labels || {}) as Record<string, string>,
						createdAt: v.CreatedAt as string,
					}));
					resolve(volumes);
				} catch (e) {
					reject(new Error(`Failed to parse Docker volumes response: ${data}`));
				}
			});
		});

		req.on("error", (e) => {
			logger.error("Failed to list Docker volumes:", e);
			reject(new Error(`Failed to connect to Docker socket: ${e.message}`));
		});

		req.end();
	});
};
