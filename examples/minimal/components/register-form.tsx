"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { signUp, useSession } from "@/components/auth-client";

export function RegisterForm() {
  const router = useRouter();
  const { isPending } = useSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const result = await signUp.email({
        email,
        password,
        name,
      });
      if (result.error) {
        setError(result.error.message || "Failed to sign up");
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
          Create an account
        </h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Enter your information to create an account
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label
            htmlFor="name"
            className="block text-sm font-medium text-black dark:text-zinc-50"
          >
            Name
          </label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="mt-2 block w-full rounded-lg border border-black/[.08] bg-white px-4 py-2.5 text-sm text-black placeholder-zinc-500 transition-colors focus:border-black focus:outline-none focus:ring-2 focus:ring-black/20 dark:border-white/[.145] dark:bg-black dark:text-zinc-50 dark:placeholder-zinc-400 dark:focus:border-white dark:focus:ring-white/20"
            placeholder="John Doe"
          />
        </div>

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
            minLength={8}
          />
          <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            Must be at least 8 characters
          </p>
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
          {isLoading ? "Creating account..." : "Sign up"}
        </button>
      </form>

      <div className="mt-6 text-center">
        <Link
          href="/login"
          className="text-sm font-medium text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          Already have an account? Sign in
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

