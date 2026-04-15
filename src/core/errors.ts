/**
 * Centralized error code to human-readable message mapping.
 *
 * Every AnonymousError in the codebase uses a snake_case error code as its
 * machine-readable identifier. This map provides a corresponding
 * human-friendly message that can be shown to end users.
 */

export const ERROR_MESSAGES: Record<string, string> = {
  // ── Authentication & Authorization ──────────────────────────────────
  not_connected:
    "You must be logged in to perform this action.",
  not_authorized:
    "You do not have permission to perform this action.",
  unable_to_connect_user:
    "Unable to connect your account. Please try again later.",
  user_not_found:
    "The requested user could not be found.",

  // ── Repository ──────────────────────────────────────────────────────
  repo_not_found:
    "The requested repository could not be found.",
  repository_expired:
    "This repository has expired and is no longer available.",
  repository_not_ready:
    "This repository is still being prepared. Please try again shortly.",
  repository_not_accessible:
    "This repository is currently not accessible.",
  invalid_repo:
    "The provided repository is not valid.",
  repo_access_limited:
    "Access to this repository is restricted.",
  repo_not_accessible:
    "The repository could not be accessed. Please check that it exists and you have permission.",
  repoId_not_defined:
    "A repository ID must be provided.",
  repoUrl_not_defined:
    "A repository URL must be provided.",
  invalid_repoId:
    "The repository ID is invalid. It must be at least 3 characters and contain only letters, numbers, hyphens, or underscores.",
  repoId_already_used:
    "This repository ID is already in use. Please choose a different one.",
  unsupported_source:
    "The repository source type is not supported.",

  // ── Branch & Commit ─────────────────────────────────────────────────
  branch_not_found:
    "The specified branch could not be found.",
  branch_not_specified:
    "A branch must be specified.",
  commit_not_specified:
    "A commit must be specified.",
  invalid_commit_format:
    "The commit hash format is invalid. It must be a hexadecimal string.",

  // ── Pull Request ────────────────────────────────────────────────────
  pull_request_not_found:
    "The requested pull request could not be found.",
  pull_request_expired:
    "This pull request has expired and is no longer available.",
  pull_request_not_ready:
    "This pull request is still being prepared. Please try again shortly.",
  pull_request_not_available:
    "This pull request is currently not available.",
  invalid_pullRequestId:
    "The pull request ID is invalid. It must be at least 3 characters and contain only letters, numbers, hyphens, or underscores.",
  pullRequestId_already_used:
    "This pull request ID is already in use. Please choose a different one.",
  repository_not_specified:
    "A repository must be specified for this pull request.",
  pullRequestId_not_specified:
    "A pull request ID must be specified.",
  pullRequestId_is_not_a_number:
    "The source pull request ID must be a number.",

  // ── File & Path ─────────────────────────────────────────────────────
  file_not_found:
    "The requested file could not be found.",
  file_not_supported:
    "This file type is not supported for the current repository configuration.",
  file_too_big:
    "The file is too large to be served.",
  file_not_accessible:
    "The requested file could not be accessed.",
  folder_not_supported:
    "Folder paths are not supported for this operation. Please request a specific file.",
  path_not_specified:
    "A file path must be specified.",
  path_not_defined:
    "The file path has not been resolved yet.",

  // ── Conference ──────────────────────────────────────────────────────
  conf_name_missing:
    "A conference name is required.",
  conf_id_missing:
    "A conference ID is required.",
  conf_id_used:
    "This conference ID is already in use. Please choose a different one.",
  conf_start_date_missing:
    "A start date is required for the conference.",
  conf_end_date_missing:
    "An end date is required for the conference.",
  conf_start_date_invalid:
    "The start date must be before the end date.",
  conf_end_date_invalid:
    "The end date must be in the future.",
  invalid_plan:
    "The selected plan is not valid.",
  conference_not_found:
    "The requested conference could not be found.",
  conf_not_found:
    "The requested conference could not be found.",
  conf_not_activated:
    "The conference is not currently active. It may not have started yet or has already ended.",

  // ── Conference Billing ──────────────────────────────────────────────
  billing_missing:
    "Billing information is required for this plan.",
  billing_name_missing:
    "A billing name is required.",
  billing_email_missing:
    "A billing email is required.",
  billing_address_missing:
    "A billing address is required.",
  billing_city_missing:
    "A billing city is required.",
  billing_zip_missing:
    "A billing ZIP/postal code is required.",
  billing_country_missing:
    "A billing country is required.",

  // ── Options & Terms ─────────────────────────────────────────────────
  options_not_provided:
    "Repository options must be provided.",
  terms_not_specified:
    "Anonymization terms must be specified.",
  invalid_terms_format:
    "Anonymization terms must be provided as an array.",

  // ── Download & Storage ──────────────────────────────────────────────
  download_not_enabled:
    "Repository downloads are not enabled on this server.",
  unable_to_download:
    "The repository could not be downloaded. Please try again later.",
  s3_config_not_provided:
    "Object storage has not been configured on this server.",

  // ── Web View ────────────────────────────────────────────────────────
  page_not_activated:
    "The website feature is not activated for this repository.",
  page_not_supported_on_different_branch:
    "The website feature is only supported on the same branch as the anonymized repository.",

  // ── Generic ─────────────────────────────────────────────────────────
  not_found:
    "The requested resource could not be found.",

  // ── Misc ────────────────────────────────────────────────────────────
  is_removed:
    "This resource has been removed and is no longer available.",
  readme_not_available:
    "The README file is not available for this repository.",

  // ── Admin ───────────────────────────────────────────────────────────
  queue_not_found:
    "The specified queue could not be found.",
  job_not_found:
    "The specified job could not be found in the queue.",
  error_retrying_job:
    "An error occurred while retrying the job.",
};

/**
 * Returns the human-readable message for a given error code.
 * Falls back to a generic message if the code is unknown.
 */
export function getErrorMessage(code: string): string {
  return (
    ERROR_MESSAGES[code] ||
    code.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())
  );
}
