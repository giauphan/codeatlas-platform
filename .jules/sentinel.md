## 2024-05-24 - Path Traversal in Project Name Resolution
**Vulnerability:** Path traversal risk allowing projects to potentially escape tenant isolation directories.
**Learning:** `path.basename()` correctly strips path components but returns `.` for `.` and `..` for `..`. When combined with `path.join()`, this can allow traversal out of a restricted directory if the input is malicious.
**Prevention:** Always validate that the output of `path.basename()` is not `.` or `..`, and ensure that inputs intended to be strings are indeed strings before processing them.
