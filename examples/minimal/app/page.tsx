"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { signOut, useSession } from "@/components/auth-client";

export default function Home() {
  const router = useRouter();
  const { data: session, isPending } = useSession();

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex min-h-screen w-full max-w-3xl flex-col items-center justify-between py-32 px-16 bg-white dark:bg-black sm:items-start">
        <div className="flex w-full items-center justify-between">

          {session ? (
            <div className="flex items-center gap-4">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">
                {session.user.email}
              </span>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await signOut();
                  } catch (error) {
                    console.error("Sign out error:", error);
                  } finally {
                    router.refresh();
                  }
                }}
                className="rounded-full border border-solid border-black/[.08] px-4 py-2 text-sm font-medium transition-colors hover:border-transparent hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-[#1a1a1a]"
              >
                Sign out
              </button>
            </div>
          ) : (
            !isPending && (
              <div className="flex gap-2">
                <Link
                  href="/register"
                  className="rounded-full border border-solid border-black/[.08] px-4 py-2 text-sm font-medium transition-colors hover:border-transparent hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-[#1a1a1a]"
                >
                  Sign up
                </Link>
                <Link
                  href="/login"
                  className="rounded-full bg-foreground px-5 py-2 text-sm font-medium text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
                >
                  Sign in
                </Link>
              </div>
            )
          )}
        </div>
        <div className="flex flex-col items-center gap-6 text-center sm:items-start sm:text-left">
          <h1 className="max-w-xs text-3xl font-semibold leading-10 tracking-tight text-black dark:text-zinc-50">
            {session ? `Welcome back, ${session.user.name || session.user.email}!` : "Better Auth + Firestore Example"}
          </h1>
          <p className="max-w-md text-lg leading-8 text-zinc-600 dark:text-zinc-400">
            {session ? (
              "You are successfully authenticated using better-auth with Firestore as your database adapter. This example demonstrates email/password authentication integrated with Google Cloud Firestore."
            ) : (
              <>
                This is an example Next.js application demonstrating{" "}
                <a
                  href="https://github.com/yultyyev/better-auth-firestore"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-zinc-950 dark:text-zinc-50 underline hover:text-zinc-700 dark:hover:text-zinc-300"
                >
                  @yultyyev/better-auth-firestore
                </a>
                . Sign up or sign in to get started and explore the authentication flow.
              </>
            )}
          </p>
          {session && (
            <div className="mt-2 rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-left dark:border-zinc-800 dark:bg-zinc-900">
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-2">Session Info:</p>
              <pre className="text-xs text-zinc-600 dark:text-zinc-400 overflow-x-auto">
                {JSON.stringify({ email: session.user.email, name: session.user.name, userId: session.user.id }, null, 2)}
              </pre>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-4 text-base font-medium sm:flex-row">
          {session ? (
            <button
              type="button"
              onClick={async () => {
                try {
                  await signOut();
                } catch (error) {
                  console.error("Sign out error:", error);
                } finally {
                  router.refresh();
                }
              }}
              className="flex h-12 w-full items-center justify-center rounded-full border border-solid border-black/[.08] px-5 transition-colors hover:border-transparent hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-[#1a1a1a] md:w-[158px]"
            >
              Sign out
            </button>
          ) : (
            <>
              <Link
                href="/register"
                className="flex h-12 w-full items-center justify-center rounded-full border border-solid border-black/[.08] px-5 transition-colors hover:border-transparent hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-[#1a1a1a] md:w-[158px]"
              >
                Sign up
              </Link>
              <Link
                href="/login"
                className="flex h-12 w-full items-center justify-center rounded-full bg-foreground px-5 text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc] md:w-[158px]"
              >
                Sign in
              </Link>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
