export default function Header({ activePage }) {
  return (
    <header className="bg-white shadow-sm">
      <div className="flex items-center justify-between px-6 py-4">
        <h2 className="text-2xl font-semibold text-gray-800">{activePage}</h2>
      </div>
    </header>
  );
}