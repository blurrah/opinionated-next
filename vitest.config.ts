import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["app/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/tmp/**",
      "**/.evals-cache/**",
      "**/.next/**",
    ],
  },
});
