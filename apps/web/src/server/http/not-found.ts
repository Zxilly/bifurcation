import "server-only";
import { notFound } from "next/navigation";
import { AppError } from "./errors";

// Turns a missing domain resource into the segment's not-found page; other
// failures reach the error boundary unchanged.
export function readOrNotFound<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound();
    throw error;
  }
}
