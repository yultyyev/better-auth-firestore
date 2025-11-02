import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";

export default async function ProtectedPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect("/login");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <div className="w-full max-w-2xl rounded-2xl border border-black/8 bg-white p-8 shadow-sm dark:border-white/15 dark:bg-black sm:p-10">
        <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
          Protected Page
        </h1>
        <p className="mt-4 text-lg text-zinc-600 dark:text-zinc-400">
          This page is server-protected. Only authenticated users can access it.
        </p>
        <div className="mt-8 rounded-lg bg-zinc-100 p-6 dark:bg-zinc-900">
          <h2 className="text-lg font-medium text-black dark:text-zinc-50">
            User Information
          </h2>
          <div className="mt-4 space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
            <p>
              <span className="font-medium">Email:</span> {session.user.email}
            </p>
            {session.user.name && (
              <p>
                <span className="font-medium">Name:</span> {session.user.name}
              </p>
            )}
            <p>
              <span className="font-medium">User ID:</span> {session.user.id}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

