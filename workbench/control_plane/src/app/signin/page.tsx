"use client";

import { signIn } from "next-auth/react";

export default function SignIn() {
  return (
    <div className="flex min-h-screen items-center justify-center p-10">
      <div className="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-900 p-8 text-center">
        <h1 className="text-xl font-semibold">CommandCenter Control Plane</h1>
        <p className="mt-2 text-sm text-zinc-400">Sign in with your Fracktal Google account.</p>
        <button
          onClick={() => signIn("google", { callbackUrl: "/" })}
          className="mt-6 w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500"
        >
          Sign in with Google
        </button>
        <p className="mt-4 text-xs text-zinc-500">
          Only <code>@fracktal.in</code> addresses are accepted.
        </p>
      </div>
    </div>
  );
}