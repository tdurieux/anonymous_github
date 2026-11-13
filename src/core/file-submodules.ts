import FileModel from "./model/files/files.model";

export async function hasVisibleSubmodules(repoId: string, generation?: string): Promise<boolean> {
  const scope = { repoId, treeGeneration: generation || { $exists: false } };
  // Separate probes prevent the OR planner choosing a scan of every generation row.
  if (await FileModel.exists({ ...scope, name: ".gitmodules", path: "" })) return true;
  const filter = { ...scope, submodule: { $exists: true, $ne: "included" } };
  try { return !!await FileModel.exists(filter).hint("file_submodule_status"); }
  catch (error) {
    // Rolling upgrades may receive requests before the additive index is installed.
    const failure = error as { code?: number; message?: string };
    if (failure.code !== 2 || !/hint.*(?:index|existing)/i.test(failure.message || "")) throw error;
    return !!await FileModel.exists(filter);
  }
}
