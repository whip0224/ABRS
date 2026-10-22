import { createFileRoute } from "@tanstack/react-router";
import { TransitApp } from "@/components/transit-app";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <TransitApp />;
}
