import { DatabaseZap, BarChart, Menu, Languages, X } from 'lucide-react';

export default function Sidebar({ isSidebarOpen, setIsSidebarOpen, activePage, setActivePage }) {
  const menuItems = [
    { name: 'Translation', icon: Languages  },
    { name: 'PageSpeed Insight', icon: BarChart  },
    { name: 'MEDU Cache', icon: DatabaseZap  },
  ];

  return (
    <aside
      className={`${
        isSidebarOpen ? 'w-64' : 'w-20'
      } bg-gray-900 text-white transition-all duration-300 ease-in-out`}
    >
      {/* Sidebar Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-700">
        <h1 className={`font-bold text-xl ${isSidebarOpen ? 'block' : 'hidden'}`}>
          DevForge
        </h1>
        <button
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          className="p-2 rounded-lg hover:bg-gray-800 transition-colors"
        >
          {isSidebarOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>

      {/* Navigation Menu */}
      <nav className="mt-6">
        <ul className="space-y-2 px-3">
          {menuItems.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.name}>
                <button
                  onClick={() => setActivePage(item.name)}
                  className={`flex items-center w-full p-3 rounded-lg transition-colors ${
                    activePage === item.name
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-300 hover:bg-gray-800'
                  }`}
                >
                  <Icon size={20} />
                  <span className={`ml-3 ${isSidebarOpen ? 'block' : 'hidden'}`}>
                    {item.name}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}