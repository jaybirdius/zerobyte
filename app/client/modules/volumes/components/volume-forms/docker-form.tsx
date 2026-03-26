import { useQuery } from "@tanstack/react-query";
import { Container, Loader2, RefreshCcw } from "lucide-react";
import type { UseFormReturn } from "react-hook-form";
import type { FormValues } from "../create-volume-form";
import { Button } from "../../../../components/ui/button";
import {
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "../../../../components/ui/form";
import { Input } from "../../../../components/ui/input";
import { cn } from "~/client/lib/utils";

type DockerVolumeInfo = {
	name: string;
	driver: string;
	mountpoint: string;
	createdAt: string;
};

type Props = {
	form: UseFormReturn<FormValues>;
};

export const DockerForm = ({ form }: Props) => {
	const { data, isLoading, refetch } = useQuery({
		queryKey: ["docker-volumes"],
		queryFn: async () => {
			const res = await fetch("/api/v1/volumes/docker/list");
			if (!res.ok) throw new Error("Failed to list Docker volumes");
			const data = await res.json();
			return data.volumes as DockerVolumeInfo[];
		},
	});

	const volumes = data || [];

	return (
		<FormField
			control={form.control}
			name="volumeName"
			render={({ field }) => (
				<FormItem>
					<FormLabel>Docker Volume</FormLabel>
					<FormControl>
						<div className="space-y-2">
							{field.value ? (
								<div className="flex items-center gap-2">
									<div className="flex-1 border rounded-md p-3 bg-muted/50">
										<div className="text-xs font-medium text-muted-foreground mb-1">Selected volume:</div>
										<div className="text-sm font-mono break-all flex items-center gap-2">
											<Container className="h-4 w-4 text-blue-400 shrink-0" />
											{field.value}
										</div>
									</div>
									<Button type="button" variant="outline" size="sm" onClick={() => field.onChange("")}>
										Change
									</Button>
								</div>
							) : (
								<>
									<div className="flex items-center justify-between">
										<Input
											placeholder="Type a volume name or select below..."
											value={field.value || ""}
											onChange={field.onChange}
										/>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											className="ml-2"
											onClick={() => refetch()}
											disabled={isLoading}
										>
											{isLoading ? (
												<Loader2 className="h-4 w-4 animate-spin" />
											) : (
												<RefreshCcw className="h-4 w-4" />
											)}
										</Button>
									</div>
									{isLoading && (
										<div className="text-sm text-muted-foreground p-4 text-center">
											<Loader2 className="h-4 w-4 animate-spin inline mr-2" />
											Loading Docker volumes...
										</div>
									)}
									{!isLoading && volumes.length > 0 && (
										<div className="border rounded-md max-h-60 overflow-y-auto">
											{volumes
												.filter((v) => v.name.length < 64) // Filter out anonymous volumes
												.map((vol) => (
													<button
														key={vol.name}
														type="button"
														onClick={() => {
															field.onChange(vol.name);
															form.setValue("name", vol.name);
														}}
														className={cn(
															"w-full text-left px-3 py-2 text-sm hover:bg-muted/50 transition-colors border-b last:border-b-0 flex items-center gap-2",
															field.value === vol.name && "bg-primary/10",
														)}
													>
														<Container className="h-3.5 w-3.5 text-blue-400 shrink-0" />
														<span className="font-mono text-xs flex-1 truncate">{vol.name}</span>
														<span className="text-xs text-muted-foreground">{vol.driver}</span>
													</button>
												))}
										</div>
									)}
									{!isLoading && volumes.length === 0 && (
										<div className="text-sm text-muted-foreground p-4 text-center border rounded-md">
											No Docker volumes found. Is the Docker socket mounted?
										</div>
									)}
								</>
							)}
						</div>
					</FormControl>
					<FormDescription>Select a Docker volume to back up. The volume data will be accessed via the Docker socket.</FormDescription>
					<FormMessage />
				</FormItem>
			)}
		/>
	);
};
