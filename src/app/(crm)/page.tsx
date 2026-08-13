import { redirect } from "next/navigation";

/** Marlon works from the Deal Room — that's home. */
export default function Home() {
  redirect("/deal-room");
}
