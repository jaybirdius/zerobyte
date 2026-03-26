import { useSuspenseQuery, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, FolderOpen, HardDrive, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "~/client/components/empty-state";
import { StatusDot } from "~/client/components/status-dot";
import { Button } from "~/client/components/ui/button";
import { Card } from "~/client/components/ui/card";
import { Input } from "~/client/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/client/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/client/components/ui/table";
import { VolumeIcon } from "~/client/components/volume-icon";
import { listVolumesOptions } from "~/client/api-client/@tanstack/react-query.gen";
import type { VolumeStatus } from "~/client/lib/types";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "~/client/lib/utils";

type VolumeGroup = {
	id: number;
	name: string;
	sortOrder: number;
};

const getVolumeStatusVariant = (status: VolumeStatus): "success" | "neutral" | "error" | "warning" => {
	const statusMap = {
		mounted: "success" as const,
		unmounted: "neutral" as const,
		error: "error" as const,
		unknown: "warning" as const,
	};
	return statusMap[status];
};

export function VolumesPage() {
	const [searchQuery, setSearchQuery] = useState("");
	const [statusFilter, setStatusFilter] = useState("");
	const [backendFilter, setBackendFilter] = useState("");
	const [collapsedGroups, setCollapsedGroups] = useState<Set<number | "ungrouped">>(new Set());
	const [newGroupName, setNewGroupName] = useState("");
	const [showGroupInput, setShowGroupInput] = useState(false);

	const queryClient = useQueryClient();
	const navigate = useNavigate();

	const clearFilters = () => {
		setSearchQuery("");
		setStatusFilter("");
		setBackendFilter("");
	};

	const { data } = useSuspenseQuery({
		...listVolumesOptions(),
	});

	const { data: groups = [] } = useQuery<VolumeGroup[]>({
		queryKey: ["volume-groups"],
		queryFn: async () => {
			const res = await fetch("/api/v1/volumes/groups");
			if (!res.ok) return [];
			return res.json();
		},
	});

	const createGroupMutation = useMutation({
		mutationFn: async (name: string) => {
			const res = await fetch("/api/v1/volumes/groups", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name }),
			});
			if (!res.ok) throw new Error("Failed to create group");
			return res.json();
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["volume-groups"] });
			setNewGroupName("");
			setShowGroupInput(false);
		},
	});

	const deleteGroupMutation = useMutation({
		mutationFn: async (id: number) => {
			const res = await fetch(`/api/v1/volumes/groups/${id}`, { method: "DELETE" });
			if (!res.ok) throw new Error("Failed to delete group");
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["volume-groups"] });
			queryClient.invalidateQueries({ queryKey: ["listVolumes"] });
		},
	});

	const assignGroupMutation = useMutation({
		mutationFn: async ({ shortId, groupId }: { shortId: string; groupId: number | null }) => {
			const res = await fetch(`/api/v1/volumes/${shortId}/group`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ groupId }),
			});
			if (!res.ok) throw new Error("Failed to assign group");
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["listVolumes"] });
		},
	});

	const filteredVolumes =
		data.filter((volume) => {
			const matchesSearch = volume.name.toLowerCase().includes(searchQuery.toLowerCase());
			const matchesStatus = !statusFilter || volume.status === statusFilter;
			const matchesBackend = !backendFilter || volume.type === backendFilter;
			return matchesSearch && matchesStatus && matchesBackend;
		}) || [];

	// Group volumes
	const groupedVolumes = new Map<number | "ungrouped", typeof filteredVolumes>();
	for (const volume of filteredVolumes) {
		const key = (volume as any).groupId ?? "ungrouped";
		if (!groupedVolumes.has(key)) groupedVolumes.set(key, []);
		groupedVolumes.get(key)!.push(volume);
	}

	const toggleGroup = (id: number | "ungrouped") => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const hasNoVolumes = data.length === 0;
	const hasNoFilteredVolumes = filteredVolumes.length === 0 && !hasNoVolumes;
	const hasGroups = groups.length > 0;

	if (hasNoVolumes) {
		return (
			<EmptyState
				icon={HardDrive}
				title="No volume"
				description="Manage and monitor all your storage backends in one place with advanced features like automatic mounting and health checks."
				button={
					<Button onClick={() => navigate({ to: "/volumes/create" })}>
						<Plus size={16} className="mr-2" />
						Create Volume
					</Button>
				}
			/>
		);
	}

	const renderVolumeRow = (volume: (typeof filteredVolumes)[0], indent = false) => (
		<TableRow
			key={volume.shortId}
			className="hover:bg-muted/50 hover:cursor-pointer transition-colors h-12"
			onClick={() => navigate({ to: `/volumes/${volume.shortId}` })}
		>
			<TableCell className="font-medium font-mono text-strong-accent">
				<div className={cn("flex items-center gap-2", indent && "pl-6")}>
					<span>{volume.name}</span>
				</div>
			</TableCell>
			<TableCell className="font-mono text-muted-foreground">
				<VolumeIcon backend={volume.type} />
			</TableCell>
			<TableCell className="text-center font-mono">
				<StatusDot
					variant={getVolumeStatusVariant(volume.status)}
					label={volume.status[0].toUpperCase() + volume.status.slice(1)}
				/>
			</TableCell>
			<TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
				{hasGroups && (
					<Select
						value={String((volume as any).groupId ?? "none")}
						onValueChange={(val) =>
							assignGroupMutation.mutate({
								shortId: volume.shortId,
								groupId: val === "none" ? null : Number(val),
							})
						}
					>
						<SelectTrigger className="w-44 h-8 text-xs">
							<SelectValue placeholder="No group" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="none">No group</SelectItem>
							{groups.map((g) => (
								<SelectItem key={g.id} value={String(g.id)}>
									{g.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}
			</TableCell>
		</TableRow>
	);

	const renderGroupSection = (groupId: number, groupName: string, volumes: typeof filteredVolumes) => {
		const isCollapsed = collapsedGroups.has(groupId);
		return (
			<>
				<TableRow
					key={`group-${groupId}`}
					className="bg-muted/30 hover:bg-muted/50 cursor-pointer transition-colors"
					onClick={() => toggleGroup(groupId)}
				>
					<TableCell colSpan={3}>
						<div className="flex items-center gap-2 font-medium">
							{isCollapsed ? (
								<ChevronRight className="h-4 w-4 text-muted-foreground" />
							) : (
								<ChevronDown className="h-4 w-4 text-muted-foreground" />
							)}
							<FolderOpen className="h-4 w-4 text-primary" />
							<span>{groupName}</span>
							<span className="text-xs text-muted-foreground font-mono ml-1">
								({volumes.length})
							</span>
						</div>
					</TableCell>
					<TableCell className="text-right">
						<Button
							variant="ghost"
							size="sm"
							className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
							onClick={(e) => {
								e.stopPropagation();
								if (confirm(`Delete group "${groupName}"? Volumes will be ungrouped.`)) {
									deleteGroupMutation.mutate(groupId);
								}
							}}
						>
							<Trash2 className="h-3.5 w-3.5" />
						</Button>
					</TableCell>
				</TableRow>
				{!isCollapsed && volumes.map((v) => renderVolumeRow(v, true))}
			</>
		);
	};

	return (
		<Card className="p-0 gap-0">
			<div className="flex flex-col lg:flex-row items-stretch lg:items-center gap-2 md:justify-between p-4 bg-card-header py-4">
				<span className="flex flex-col sm:flex-row items-stretch md:items-center gap-2 flex-wrap">
					<Input
						className="w-full lg:w-45 min-w-45"
						placeholder="Search…"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
					/>
					<Select value={statusFilter} onValueChange={setStatusFilter}>
						<SelectTrigger className="w-full lg:w-45 min-w-45">
							<SelectValue placeholder="All status" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="mounted">Mounted</SelectItem>
							<SelectItem value="unmounted">Unmounted</SelectItem>
							<SelectItem value="error">Error</SelectItem>
						</SelectContent>
					</Select>
					<Select value={backendFilter} onValueChange={setBackendFilter}>
						<SelectTrigger className="w-full lg:w-45 min-w-45">
							<SelectValue placeholder="All backends" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="directory">Directory</SelectItem>
							<SelectItem value="docker">Docker</SelectItem>
							<SelectItem value="nfs">NFS</SelectItem>
							<SelectItem value="smb">SMB</SelectItem>
							<SelectItem value="sftp">SFTP</SelectItem>
							<SelectItem value="webdav">WebDAV</SelectItem>
							<SelectItem value="rclone">Rclone</SelectItem>
						</SelectContent>
					</Select>
					{(searchQuery || statusFilter || backendFilter) && (
						<Button onClick={clearFilters} className="w-full lg:w-auto mt-2 lg:mt-0 lg:ml-2">
							<RotateCcw className="h-4 w-4 mr-2" />
							Clear filters
						</Button>
					)}
				</span>
				<span className="flex gap-2">
					{showGroupInput ? (
						<span className="flex gap-1">
							<Input
								className="w-40 h-9"
								placeholder="Group name..."
								value={newGroupName}
								onChange={(e) => setNewGroupName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && newGroupName.trim()) {
										createGroupMutation.mutate(newGroupName.trim());
									}
									if (e.key === "Escape") {
										setShowGroupInput(false);
										setNewGroupName("");
									}
								}}
								autoFocus
							/>
							<Button
								size="sm"
								className="h-9"
								disabled={!newGroupName.trim()}
								onClick={() => createGroupMutation.mutate(newGroupName.trim())}
							>
								Add
							</Button>
							<Button
								size="sm"
								variant="ghost"
								className="h-9"
								onClick={() => {
									setShowGroupInput(false);
									setNewGroupName("");
								}}
							>
								Cancel
							</Button>
						</span>
					) : (
						<Button variant="outline" onClick={() => setShowGroupInput(true)}>
							<FolderOpen size={16} className="mr-2" />
							New Group
						</Button>
					)}
					<Button onClick={() => navigate({ to: "/volumes/create" })}>
						<Plus size={16} className="mr-2" />
						Create Volume
					</Button>
				</span>
			</div>
			<div className="overflow-x-auto">
				<Table className="border-t">
					<TableHeader className="bg-card-header">
						<TableRow>
							<TableHead className="w-25 uppercase">Name</TableHead>
							<TableHead className="uppercase text-left">Backend</TableHead>
							<TableHead className="uppercase text-center">Status</TableHead>
							<TableHead className="uppercase text-right w-48">Group</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						<TableRow className={cn({ hidden: !hasNoFilteredVolumes })}>
							<TableCell colSpan={4} className="text-center py-12">
								<div className="flex flex-col items-center gap-3">
									<p className="text-muted-foreground">No volumes match your filters.</p>
									<Button onClick={clearFilters} variant="outline" size="sm">
										<RotateCcw className="h-4 w-4 mr-2" />
										Clear filters
									</Button>
								</div>
							</TableCell>
						</TableRow>
						{/* Render grouped volumes first */}
						{groups.map((group) => {
							const vols = groupedVolumes.get(group.id);
							if (!vols || vols.length === 0) return null;
							return renderGroupSection(group.id, group.name, vols);
						})}
						{/* Render ungrouped volumes */}
						{(groupedVolumes.get("ungrouped") || []).map((volume) =>
							renderVolumeRow(volume, false),
						)}
					</TableBody>
				</Table>
			</div>
			<div className="px-4 py-2 text-sm text-muted-foreground bg-card-header flex justify-end border-t font-mono">
				{hasNoFilteredVolumes ? (
					"No volumes match filters."
				) : (
					<span className="font-mono">
						<span className="text-strong-accent font-bold">{filteredVolumes.length}</span> volume
						{filteredVolumes.length > 1 ? "s" : ""}
						{groups.length > 0 && (
							<>
								{" "}in <span className="text-strong-accent font-bold">{groups.length}</span> group
								{groups.length > 1 ? "s" : ""}
							</>
						)}
					</span>
				)}
			</div>
		</Card>
	);
}
