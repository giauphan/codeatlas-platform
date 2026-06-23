🎯 **What:** The testing gap for the invalid Firebase ID Token edge case in `src/middleware/auth.ts` has been addressed.
📊 **Coverage:** The scenario where `getAuth().verifyIdToken()` throws an error is now explicitly tested, ensuring a 401 response and the correct error message format are returned.
✨ **Result:** Improved test coverage for error conditions in the authentication middleware, making the codebase more reliable and catching regressions if the error handling changes.
