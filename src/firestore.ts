import { type AppOptions, getApps, initializeApp } from "firebase-admin/app";
import {
	type Firestore,
	getFirestore,
	initializeFirestore,
} from "firebase-admin/firestore";

/**
 * Initialize or reuse a Firestore instance safely (useful in serverless).
 * If an app with the provided name exists, reuse it; otherwise initialize.
 */
export function initFirestore(
	options: AppOptions & { name?: string } = {},
): Firestore {
	// Reuse existing app by name if exists, otherwise initialize
	const apps = getApps();
	const app = options.name
		? apps.find((a) => a.name === options.name)
		: apps[0];
	if (app) return getFirestore(app);
	return initializeFirestore(initializeApp(options, options.name));
}
