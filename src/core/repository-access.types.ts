/** A resource connection, never a bearer credential. Missing means legacy OAuth. */
export interface RepositoryAccess {
  kind: "oauth" | "github-app";
  repositoryId?: number;
  installationId?: number;
  revision: string;
}
