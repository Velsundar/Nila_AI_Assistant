"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/components/AuthProvider";
import { FullScreenLoader } from "@/components/ui";

export default function Home() {
  const { status } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (status === "authed") router.replace("/today");
    else if (status === "anon") router.replace("/login");
  }, [status, router]);
  return <FullScreenLoader />;
}
