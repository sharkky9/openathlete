// Pulls in the jest-dom matcher augmentation (`toBeInTheDocument`,
// `toBeDisabled`, …) for Vitest's `expect`. Importing it here rather than in
// each test keeps `tsc --noEmit` and the test runner agreeing on the matcher
// set; `vitest.setup.ts` performs the matching runtime registration.
import '@testing-library/jest-dom/vitest';
