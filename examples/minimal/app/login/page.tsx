"use client";

import { useRouter } from "next/navigation";

import { useSession } from "@/components/auth-client";
import { LoginForm } from "@/components/login-form";

export default function LoginPage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();

  if (session && !isPending) {
    router.push("/");
    return null;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <LoginForm />
    </div>
  );
}

