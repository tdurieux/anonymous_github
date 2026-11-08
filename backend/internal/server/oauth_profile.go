package server

func validateAppProfile(profile M) error {
	if !jsonSafeInteger(profile["id"]) || !inputTruthy(profile["login"]) {
		return fail("github_app_reconnect_required", 403)
	}
	return nil
}
