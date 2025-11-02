"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { signIn, useSession } from "@/components/auth-client";

export function LoginForm() {
  const router = useRouter();
  const { isPending } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const result = await signIn.email({
        email,
        password,
      });
      if (result.error) {
        setError(result.error.message || "Failed to sign in");
      } else {
        router.push("/");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unexpected error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="w-full max-w-md rounded-2xl border border-black/[.08] bg-white p-8 shadow-sm dark:border-white/[.145] dark:bg-black sm:p-10">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
          Welcome back
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Sign in to your account to continue
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label
            htmlFor="email"
            className="block text-sm font-medium text-black dark:text-zinc-50"
          >
            Email
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="mt-2 block w-full rounded-lg border border-black/[.08] bg-white px-4 py-2.5 text-sm text-black placeholder-zinc-500 transition-colors focus:border-black focus:outline-none focus:ring-2 focus:ring-black/20 dark:border-white/[.145] dark:bg-black dark:text-zinc-50 dark:placeholder-zinc-400 dark:focus:border-white dark:focus:ring-white/20"
            placeholder="you@example.com"
          />
        </div>

        <div>
          <label
            htmlFor="password"
            className="block text-sm font-medium text-black dark:text-zinc-50"
          >
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="mt-2 block w-full rounded-lg border border-black/[.08] bg-white px-4 py-2.5 text-sm text-black placeholder-zinc-500 transition-colors focus:border-black focus:outline-none focus:ring-2 focus:ring-black/20 dark:border-white/[.145] dark:bg-black dark:text-zinc-50 dark:placeholder-zinc-400 dark:focus:border-white dark:focus:ring-white/20"
            placeholder="••••••••"
          />
        </div>

        {error && (
          <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/20 dark:text-red-400">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={isLoading || isPending}
          className="w-full rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-[#ccc]"
        >
          {isLoading ? "Loading..." : "Sign in"}
        </button>
      </form>

      <div className="mt-6 text-center">
        <Link
          href="/register"
          className="text-sm font-medium text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          Don&apos;t have an account? Sign up
        </Link>
      </div>

      <div className="mt-8 border-t border-black/[.08] pt-6 dark:border-white/[.145]">
        <Link
          href="/"
          className="block text-center text-sm text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          ← Back to home
        </Link>
      </div>
    </div>
  );
}

