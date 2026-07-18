import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  if (env.VERCEL === "1") {
    const apiUrl = env.VITE_API_BASE_URL;
    if (!apiUrl || !apiUrl.startsWith("https://")) {
      throw new Error("Vercel потребує VITE_API_BASE_URL з HTTPS-адресою Render");
    }
  }

  return {
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: 5173
    }
  };
});
