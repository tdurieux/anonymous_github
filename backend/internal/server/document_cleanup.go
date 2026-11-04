package server

// Preserve metadata that TypeScript's resetSate leaves on the tombstone, while
// removing the content and identity fields it explicitly clears. Copy first so
// preparing the update does not alter the loaded resource snapshot.
func clearedDocumentPayload(kind string, value any) M {
	out := M{}
	for key, value := range obj(value) {
		out[key] = value
	}
	out["comments"] = []any{}
	if kind == "gist" {
		out["description"] = ""
		out["files"] = []any{}
		out["ownerLogin"] = ""
	} else {
		for _, key := range []string{"body", "title", "diff", "baseRepositoryFullName", "headRepositoryFullName"} {
			out[key] = ""
		}
		out["state"] = "closed"
		out["draft"] = false
		out["merged"] = false
		delete(out, "mergedDate")
	}
	return out
}
