// Legacy bdapps gateway proxy endpoint, intentionally retired.
//
// The Flutter client now talks to the bdapps gateway directly and calls
// `/api/auth/bdapps/login` to mint a local session. This file remains only
// to keep the directory structure stable for any future proxy work.
//
// The empty module satisfies Next.js's route generation (it needs the
// file to export something) and tsc (which requires `export {}` for a
// file to be a module under `verbatimModuleSyntax`).
export {};
