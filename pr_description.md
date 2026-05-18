🎯 **What:**
Replaced the use of the `any` type in `catch` blocks with `unknown` across the entire codebase (backend and frontend files). Added appropriate type narrowing where error objects are accessed.

💡 **Why:**
In TypeScript, errors caught in a try/catch block default to type `unknown`. Explicitly typing them as `any` defeats TypeScript's safety mechanisms by bypassing type checking. Changing to `unknown` and applying type narrowing (e.g. `err instanceof Error ? err.message : String(err)`) prevents potential runtime exceptions if the thrown value is not an Error object (like throwing a string or null), thereby improving overall codebase stability and maintainability.

✅ **Verification:**
Ran backend unit tests (`npm test`), all pass successfully.
Built the frontend (`cd dashboard && pnpm build`), compiled successfully.
Manually checked the transpiled outputs in `dist` to verify the build process is functional.

✨ **Result:**
Enhanced type-safety in error-handling pathways without altering runtime behavior, making the code safer and more aligned with TypeScript best practices.
