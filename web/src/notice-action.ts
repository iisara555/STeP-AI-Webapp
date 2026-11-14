// Error codes whose notice offers a follow-up button (App.tsx routes it). STORAGE_FULL is deliberately absent:
// the documents page that STORAGE_QUOTA opens does not exist in Cloud Workspace, so it would lead nowhere.
export const noticeHasAction = (code: string) =>
  /^(UNAUTHENTICATED|ACCESS_DENIED|AI_|HARNESS_|SERVER_NOT_CONFIGURED|GOOGLE_|STORAGE_QUOTA|DOCUMENT_|FILE_INVALID|UPLOAD_PENDING|NETWORK_ERROR|MEMBER_LIMIT|MEMORY_LIMIT)/.test(
    code,
  );
