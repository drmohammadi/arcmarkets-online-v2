'use client';

/**
 * Global error boundary for the App Router. Catches render/runtime errors in
 * any route segment and shows a safe fallback instead of a blank screen.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex flex-1 items-center justify-center px-6">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-bold mb-2">Something went wrong</h1>
        <p className="text-sm text-gray-500 mb-6">
          An unexpected error occurred. Your funds are safe — this is a display error.
        </p>
        <button
          onClick={() => reset()}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
