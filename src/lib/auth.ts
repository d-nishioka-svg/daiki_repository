import { initializeApp } from "firebase/app";
import {
  getAuth,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
  signOut,
} from "firebase/auth";
import firebaseConfig from "../../firebase-applet-config.json";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
// Request necessary Google Sheets and structural Drive file scopes
provider.addScope("https://www.googleapis.com/auth/spreadsheets");
provider.addScope("https://www.googleapis.com/auth/drive.file");

let isSigningIn = false;
let cachedAccessToken: string | null = null;
let redirectPromise: Promise<any> | null = null;

// Initialize auth state listener
export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void,
) => {
  if (!redirectPromise) {
    redirectPromise = getRedirectResult(auth)
      .then((result) => {
        if (result) {
          const credential = GoogleAuthProvider.credentialFromResult(result);
          if (credential?.accessToken) {
            cachedAccessToken = credential.accessToken;
          }
        }
        return result;
      })
      .catch((error) => {
        console.error("Redirect auth error:", error);
        return null;
      });
  }

  return onAuthStateChanged(auth, async (user: User | null) => {
    // Wait for any pending redirect result before evaluating state
    await redirectPromise;

    if (user) {
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        // If we have a user but no cached token (like on page reload), we can sign out or trigger sign-in to refresh
        cachedAccessToken = null;
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      if (onAuthFailure) onAuthFailure();
    }
  });
};

/** True when the app is running inside an iframe, e.g. the AI Studio preview. */
export const isEmbedded = (): boolean => {
  try {
    return window.self !== window.top;
  } catch {
    // A cross-origin parent throws on access, which itself means we are embedded.
    return true;
  }
};

/**
 * Popup sign-in fails in several ways that all mean "the popup could not talk
 * back to this page", not "the user changed their mind". Inside a cross-origin
 * iframe the opener handshake is blocked and Firebase reports the popup as
 * closed by the user, so only retrying on popup-blocked left the operator with a
 * bare "Authentication failed" and no way forward.
 */
const POPUP_UNAVAILABLE_CODES = new Set([
  "auth/popup-blocked",
  "auth/popup-closed-by-user",
  "auth/cancelled-popup-request",
  "auth/operation-not-supported-in-this-environment",
  "auth/web-storage-unsupported",
]);

// Must be called from a button click or user interaction
export const googleSignIn = async (): Promise<{
  user: User;
  accessToken: string;
} | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error(
        "Failed to get Google Sheets API access token from authentication.",
      );
    }

    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error("Sign in error:", error);

    if (POPUP_UNAVAILABLE_CODES.has(error?.code)) {
      // Redirect cannot complete inside an iframe either — the flow would return
      // to the embedded document and be blocked the same way — so let the caller
      // send the operator to a top-level window instead.
      if (isEmbedded()) {
        const embeddedError: any = new Error(
          "埋め込み表示ではGoogleサインインを完了できません。アプリを新しいタブで開いてください。",
        );
        embeddedError.code = "app/embedded-auth-unavailable";
        throw embeddedError;
      }

      await signInWithRedirect(auth, provider);
      return null;
    }

    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken;
};

export const logout = async () => {
  await signOut(auth);
  cachedAccessToken = null;
};
