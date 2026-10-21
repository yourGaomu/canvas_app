import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.mikasa.infinitecanvas",
  appName: "Infinite Canvas",
  webDir: "dist",
  android: {
    loggingBehavior: "none",
    adjustMarginsForEdgeToEdge: "force",
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
  server: {
    androidScheme: "https",
  },
};

export default config;
