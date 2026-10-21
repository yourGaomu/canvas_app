import { Capacitor, registerPlugin } from "@capacitor/core";

interface CanvasOrientationPlugin {
  enter(): Promise<void>;
  exit(): Promise<void>;
}

const NativeCanvasOrientation = registerPlugin<CanvasOrientationPlugin>("CanvasOrientation");

export async function enterCanvasLandscape() {
  if (Capacitor.getPlatform() === "android") {
    try {
      await NativeCanvasOrientation.enter();
      return true;
    } catch {
      // Fall through to the browser orientation API when the native plugin is unavailable.
    }
  }

  try {
    const orientation = window.screen.orientation as ScreenOrientation & {
      lock?: (orientation: "landscape") => Promise<void>;
    };
    if (!orientation || typeof orientation.lock !== "function") return false;
    await orientation.lock("landscape");
    return true;
  } catch {
    return false;
  }
}

export async function exitCanvasLandscape() {
  if (Capacitor.getPlatform() === "android") {
    try {
      await NativeCanvasOrientation.exit();
    } catch {
      // The web orientation lock can still be released if the native bridge is unavailable.
    }
  }

  try {
    window.screen.orientation?.unlock();
  } catch {
    // Some browsers do not implement orientation unlock.
  }
}
