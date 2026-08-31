import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex flex-1 items-center justify-center px-6">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-bold mb-2">Page not found</h1>
        <p className="text-sm text-gray-500 mb-6">
          The page you&apos;re looking for doesn&apos;t exist.
        </p>
        <Link href="/" className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
          Back to markets
        </Link>
      </div>
    </main>
  );
}
