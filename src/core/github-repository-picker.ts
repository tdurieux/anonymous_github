import { octokit } from "./GitHubUtils";

/** One upstream page per request. Search cursors resume within that page. */
export async function repositoryPickerPage(token: string, cursor = 0, query = "") {
  const size = query ? 100 : 20;
  const page = Math.floor(cursor / size) + 1;
  const offset = cursor % size;
  const response = await octokit(token).request("GET /user/repos", {
    visibility: "all", sort: "full_name", direction: "asc", per_page: size, page,
  });
  const items: { id: number; fullName: string }[] = [];
  let index = offset;
  for (; index < response.data.length; index++) {
    const repo = response.data[index];
    if (!query || repo.full_name.toLowerCase().includes(query.toLowerCase())) {
      items.push({ id: repo.id, fullName: repo.full_name });
      if (items.length === 20) { index++; break; }
    }
  }
  const hasNext = index < response.data.length || /rel="next"/.test(response.headers.link || "");
  return { items, nextCursor: hasNext ? (page - 1) * size + index : null };
}
