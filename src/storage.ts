import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import { SecureStoragePlugin } from "capacitor-secure-storage-plugin";
import type { AuthSession, GeneratedAsset, MobileCanvasProject } from "./types";

const SESSION_KEY = "infinite-canvas-mobile-session";
const ASSETS_KEY = "infinite-canvas-mobile-assets";
const CANVAS_PROJECTS_KEY = "infinite-canvas-mobile-canvas-projects";

export async function readSession(): Promise<AuthSession | null> {
  try {
    const value = Capacitor.isNativePlatform() ? (await SecureStoragePlugin.get({ key: SESSION_KEY })).value : localStorage.getItem(SESSION_KEY);
    return value ? (JSON.parse(value) as AuthSession) : null;
  } catch {
    return null;
  }
}

export async function writeSession(session: AuthSession) {
  const value = JSON.stringify(session);
  if (Capacitor.isNativePlatform()) await SecureStoragePlugin.set({ key: SESSION_KEY, value });
  else localStorage.setItem(SESSION_KEY, value);
}

export async function clearSession() {
  if (Capacitor.isNativePlatform()) await SecureStoragePlugin.remove({ key: SESSION_KEY });
  else localStorage.removeItem(SESSION_KEY);
}

export async function readAssets(): Promise<GeneratedAsset[]> {
  const result = await Preferences.get({ key: ASSETS_KEY });
  try {
    return result.value ? (JSON.parse(result.value) as GeneratedAsset[]) : [];
  } catch {
    return [];
  }
}

export async function writeAssets(assets: GeneratedAsset[]) {
  await Preferences.set({ key: ASSETS_KEY, value: JSON.stringify(assets.slice(0, 60)) });
}

export async function readCanvasProjects(): Promise<MobileCanvasProject[]> {
  const result = await Preferences.get({ key: CANVAS_PROJECTS_KEY });
  try {
    return result.value ? (JSON.parse(result.value) as MobileCanvasProject[]) : [];
  } catch {
    return [];
  }
}

export async function writeCanvasProjects(projects: MobileCanvasProject[]) {
  await Preferences.set({ key: CANVAS_PROJECTS_KEY, value: JSON.stringify(projects) });
}
