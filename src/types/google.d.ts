// Ambient type declarations for the Google Identity Services (GSI)
// client library loaded from accounts.google.com/gsi/client. Subset of
// the full surface: only the calls we use (initialize, renderButton,
// prompt, cancel, disableAutoSelect). Full reference:
// https://developers.google.com/identity/gsi/web/reference/js-reference

declare namespace google.accounts.id {
  interface CredentialResponse {
    /** Google-issued JWT ID token. Pass to Firebase via
     *  GoogleAuthProvider.credential(idToken) → signInWithCredential. */
    credential: string;
    select_by:
      | "auto"
      | "user"
      | "user_1tap"
      | "user_2tap"
      | "btn"
      | "btn_confirm"
      | "btn_add_session"
      | "btn_confirm_add_session";
    /** Present when GSI is configured with state in initialize(). */
    state?: string;
  }

  interface IdConfiguration {
    client_id: string;
    callback: (response: CredentialResponse) => void;
    /** Auto-sign-in on page load if the user has previously consented and
     *  has exactly one session — off by default to give the user a
     *  chance to swap accounts via One Tap. */
    auto_select?: boolean;
    /** Close One Tap when the user clicks outside. Default false. */
    cancel_on_tap_outside?: boolean;
    /** Tweaks the storage strategy for browsers with strict ITP (Safari).
     *  Recommended on for any modern web app. */
    itp_support?: boolean;
    /** ux_mode: "popup" uses FedCM where supported, falls back to a
     *  cross-origin popup. "redirect" navigates the top frame. We use
     *  "popup" so the click stays inline. */
    ux_mode?: "popup" | "redirect";
    login_uri?: string;
    use_fedcm_for_prompt?: boolean;
    use_fedcm_for_button?: boolean;
    nonce?: string;
    context?: "signin" | "signup" | "use";
    state_cookie_domain?: string;
  }

  interface GsiButtonConfiguration {
    type?: "standard" | "icon";
    theme?: "outline" | "filled_blue" | "filled_black";
    size?: "large" | "medium" | "small";
    text?: "signin_with" | "signup_with" | "continue_with" | "signin";
    shape?: "rectangular" | "pill" | "circle" | "square";
    logo_alignment?: "left" | "center";
    width?: string | number;
    locale?: string;
    click_listener?: () => void;
  }

  interface PromptMomentNotification {
    isDisplayMoment(): boolean;
    isDisplayed(): boolean;
    isNotDisplayed(): boolean;
    getNotDisplayedReason():
      | "browser_not_supported"
      | "invalid_client"
      | "missing_client_id"
      | "opt_out_or_no_session"
      | "secure_http_required"
      | "suppressed_by_user"
      | "unregistered_origin"
      | "unknown_reason";
    isSkippedMoment(): boolean;
    getSkippedReason():
      | "auto_cancel"
      | "user_cancel"
      | "tap_outside"
      | "issuing_failed";
    isDismissedMoment(): boolean;
    getDismissedReason():
      | "credential_returned"
      | "cancel_called"
      | "flow_restarted";
    getMomentType(): "display" | "skipped" | "dismissed";
  }

  function initialize(config: IdConfiguration): void;
  function renderButton(parent: HTMLElement, options: GsiButtonConfiguration): void;
  function prompt(callback?: (notification: PromptMomentNotification) => void): void;
  function cancel(): void;
  function disableAutoSelect(): void;
}

interface Window {
  google?: {
    accounts: {
      id: typeof google.accounts.id;
    };
  };
}
