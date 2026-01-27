import React, { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Code, Component, Zap, Database, Wrench, Palette } from 'lucide-react';

const ReactCheatsheet = () => {
    const [copiedCode, setCopiedCode] = useState<string | null>(null);

    const copyToClipboard = (code: string, id: string) => {
        navigator.clipboard.writeText(code);
        setCopiedCode(id);
        setTimeout(() => setCopiedCode(null), 2000);
    };

    const CodeBlock = ({ code, id, title }: { code: string; id: string; title?: string }) => (
        <div className="relative group">
            {title && <div className="text-sm font-semibold text-slate-700 mb-2">{title}</div>}
            <pre className="border p-4 rounded-lg overflow-x-auto text-sm table-scroll-area">
                <code>{code}</code>
            </pre>
            <button
                onClick={() => copyToClipboard(code, id)}
                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-700 hover:bg-slate-600 text-white px-3 py-1 rounded text-xs"
            >
                {copiedCode === id ? 'Copied!' : 'Copy'}
            </button>
        </div>
    );

    return (
        <div className="min-h-screen bg-gradient-to-br">
            <div className="container mx-auto px-4 py-8 max-w-7xl">

                <Tabs defaultValue="basics" className="w-full">
                    <TabsList className="grid w-full grid-cols-2 lg:grid-cols-6 mb-8 h-auto">
                        <TabsTrigger value="basics" className="gap-2">
                            <Code className="w-4 h-4" />
                            Basics
                        </TabsTrigger>
                        <TabsTrigger value="hooks" className="gap-2">
                            <Zap className="w-4 h-4" />
                            Hooks
                        </TabsTrigger>
                        <TabsTrigger value="components" className="gap-2">
                            <Component className="w-4 h-4" />
                            Components
                        </TabsTrigger>
                        <TabsTrigger value="state" className="gap-2">
                            <Database className="w-4 h-4" />
                            State
                        </TabsTrigger>
                        <TabsTrigger value="advanced" className="gap-2">
                            <Wrench className="w-4 h-4" />
                            Advanced
                        </TabsTrigger>
                        <TabsTrigger value="styling" className="gap-2">
                            <Palette className="w-4 h-4" />
                            Styling
                        </TabsTrigger>
                    </TabsList>

                    {/* Basics Tab */}
                    <TabsContent value="basics">
                        <div className="grid gap-6 md:grid-cols-2">
                            <Card>
                                <CardHeader>
                                    <CardTitle>Functional Component</CardTitle>
                                    <CardDescription>Basic TypeScript function component</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="func-comp"
                                        code={`interface Props {
  name: string;
  age?: number;
}

const MyComponent: React.FC<Props> = ({ name, age }) => {
  return (
    <div>
      <h1>Hello, {name}</h1>
      {age && <p>Age: {age}</p>}
    </div>
  );
};`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Props with Children</CardTitle>
                                    <CardDescription>Component accepting children</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="props-children"
                                        code={`interface Props {
  title: string;
  children: React.ReactNode;
}

const Container: React.FC<Props> = ({ title, children }) => {
  return (
    <div>
      <h2>{title}</h2>
      <div>{children}</div>
    </div>
  );
};`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>JSX Expressions</CardTitle>
                                    <CardDescription>Common JSX patterns</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="jsx-expr"
                                        code={`const Component = () => {
  const isLoggedIn = true;
  const items = ['Apple', 'Banana', 'Orange'];
  
  return (
    <>
      {/* Conditional rendering */}
      {isLoggedIn && <p>Welcome back!</p>}
      
      {/* Ternary operator */}
      {isLoggedIn ? <Dashboard /> : <Login />}
      
      {/* List rendering */}
      <ul>
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </>
  );
};`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Event Handling</CardTitle>
                                    <CardDescription>Handling user interactions</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="events"
                                        code={`const EventExample = () => {
  const handleClick = () => {
    console.log('Clicked!');
  };
  
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    console.log(e.target.value);
  };
  
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    console.log('Submitted!');
  };
  
  return (
    <div>
      <button onClick={handleClick}>Click me</button>
      <input onChange={handleChange} />
      <form onSubmit={handleSubmit}>
        <button type="submit">Submit</button>
      </form>
    </div>
  );
};`}
                                    />
                                </CardContent>
                            </Card>
                        </div>
                    </TabsContent>

                    {/* Hooks Tab */}
                    <TabsContent value="hooks">
                        <div className="grid gap-6 md:grid-cols-2">
                            <Card>
                                <CardHeader>
                                    <CardTitle>useState</CardTitle>
                                    <CardDescription>Managing component state</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="use-state"
                                        code={`const Counter = () => {
  const [count, setCount] = useState<number>(0);
  const [user, setUser] = useState<User | null>(null);
  
  // Update state
  setCount(count + 1);
  
  // Functional update
  setCount(prev => prev + 1);
  
  // Update object state
  setUser({ name: 'John', age: 30 });
  
  return <div>Count: {count}</div>;
};`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>useEffect</CardTitle>
                                    <CardDescription>Side effects and lifecycle</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="use-effect"
                                        code={`const DataFetcher = () => {
  const [data, setData] = useState(null);
  
  // Run once on mount
  useEffect(() => {
    fetchData();
  }, []);
  
  // Run when dependency changes
  useEffect(() => {
    console.log(data);
  }, [data]);
  
  // Cleanup function
  useEffect(() => {
    const timer = setInterval(() => {}, 1000);
    return () => clearInterval(timer);
  }, []);
  
  return <div>{/* ... */}</div>;
};`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>useRef</CardTitle>
                                    <CardDescription>DOM references and mutable values</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="use-ref"
                                        code={`const InputFocus = () => {
  const inputRef = useRef<HTMLInputElement>(null);
  const countRef = useRef<number>(0);
  
  const focusInput = () => {
    inputRef.current?.focus();
  };
  
  // Mutable value without re-render
  countRef.current += 1;
  
  return (
    <div>
      <input ref={inputRef} />
      <button onClick={focusInput}>Focus</button>
    </div>
  );
};`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>useContext</CardTitle>
                                    <CardDescription>Accessing context values</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="use-context"
                                        code={`// Create context
const ThemeContext = createContext<'light' | 'dark'>('light');

// Provider
const App = () => (
  <ThemeContext.Provider value="dark">
    <Component />
  </ThemeContext.Provider>
);

// Consumer
const Component = () => {
  const theme = useContext(ThemeContext);
  return <div>Theme: {theme}</div>;
};`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>useMemo</CardTitle>
                                    <CardDescription>Memoize expensive calculations</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="use-memo"
                                        code={`const ExpensiveComponent = ({ data }: Props) => {
  const processedData = useMemo(() => {
    // Expensive calculation
    return data.map(item => 
      heavyComputation(item)
    );
  }, [data]); // Only recalculate when data changes
  
  return <div>{processedData}</div>;
};`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>useCallback</CardTitle>
                                    <CardDescription>Memoize callback functions</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="use-callback"
                                        code={`const Parent = () => {
  const [count, setCount] = useState(0);
  
  // Memoized callback
  const handleClick = useCallback(() => {
    setCount(c => c + 1);
  }, []); // Empty deps - function never changes
  
  return <Child onClick={handleClick} />;
};`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>useReducer</CardTitle>
                                    <CardDescription>Complex state management</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="use-reducer"
                                        code={`type State = { count: number };
type Action = 
  | { type: 'increment' }
  | { type: 'decrement' };

const reducer = (state: State, action: Action) => {
  switch (action.type) {
    case 'increment':
      return { count: state.count + 1 };
    case 'decrement':
      return { count: state.count - 1 };
    default:
      return state;
  }
};

const Counter = () => {
  const [state, dispatch] = useReducer(reducer, { count: 0 });
  
  return (
    <div>
      <p>{state.count}</p>
      <button onClick={() => dispatch({ type: 'increment' })}>+</button>
    </div>
  );
};`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Custom Hooks</CardTitle>
                                    <CardDescription>Reusable logic extraction</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="custom-hooks"
                                        code={`// Custom hook
const useFetch = <T,>(url: string) => {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  
  useEffect(() => {
    fetch(url)
      .then(res => res.json())
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [url]);
  
  return { data, loading, error };
};

// Usage
const Component = () => {
  const { data, loading, error } = useFetch<User>('/api/user');
  
  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error!</div>;
  return <div>{data?.name}</div>;
};`}
                                    />
                                </CardContent>
                            </Card>
                        </div>
                    </TabsContent>

                    {/* Components Tab */}
                    <TabsContent value="components">
                        <div className="grid gap-6 md:grid-cols-2">
                            <Card>
                                <CardHeader>
                                    <CardTitle>Component Composition</CardTitle>
                                    <CardDescription>Building reusable components</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="composition"
                                        code={`// Container component
const Card = ({ children }: { children: React.ReactNode }) => (
  <div className="card">{children}</div>
);

Card.Header = ({ children }: { children: React.ReactNode }) => (
  <div className="card-header">{children}</div>
);

Card.Body = ({ children }: { children: React.ReactNode }) => (
  <div className="card-body">{children}</div>
);

// Usage
<Card>
  <Card.Header>Title</Card.Header>
  <Card.Body>Content</Card.Body>
</Card>`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Higher-Order Components</CardTitle>
                                    <CardDescription>Component wrapper pattern</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="hoc"
                                        code={`// HOC definition
const withAuth = <P extends object>(
  Component: React.ComponentType<P>
) => {
  return (props: P) => {
    const { isAuthenticated } = useAuth();
    
    if (!isAuthenticated) {
      return <Login />;
    }
    
    return <Component {...props} />;
  };
};

// Usage
const Dashboard = () => <div>Dashboard</div>;
const ProtectedDashboard = withAuth(Dashboard);`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Render Props</CardTitle>
                                    <CardDescription>Sharing logic via props</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="render-props"
                                        code={`interface MouseTrackerProps {
  render: (position: { x: number; y: number }) => React.ReactNode;
}

const MouseTracker: React.FC<MouseTrackerProps> = ({ render }) => {
  const [position, setPosition] = useState({ x: 0, y: 0 });
  
  const handleMouseMove = (e: React.MouseEvent) => {
    setPosition({ x: e.clientX, y: e.clientY });
  };
  
  return (
    <div onMouseMove={handleMouseMove}>
      {render(position)}
    </div>
  );
};

// Usage
<MouseTracker 
  render={({ x, y }) => <p>Mouse at {x}, {y}</p>}
/>`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Compound Components</CardTitle>
                                    <CardDescription>Related components working together</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="compound"
                                        code={`const TabsContext = createContext<{
  activeTab: string;
  setActiveTab: (tab: string) => void;
} | null>(null);

const Tabs = ({ children }: { children: React.ReactNode }) => {
  const [activeTab, setActiveTab] = useState('tab1');
  
  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab }}>
      <div>{children}</div>
    </TabsContext.Provider>
  );
};

Tabs.List = ({ children }: { children: React.ReactNode }) => (
  <div className="tabs-list">{children}</div>
);

Tabs.Tab = ({ id, children }: { id: string; children: React.ReactNode }) => {
  const context = useContext(TabsContext);
  return (
    <button onClick={() => context?.setActiveTab(id)}>
      {children}
    </button>
  );
};`}
                                    />
                                </CardContent>
                            </Card>
                        </div>
                    </TabsContent>

                    {/* State Management Tab */}
                    <TabsContent value="state">
                        <div className="grid gap-6 md:grid-cols-2">
                            <Card>
                                <CardHeader>
                                    <CardTitle>Context API Pattern</CardTitle>
                                    <CardDescription>Global state with Context</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="context-pattern"
                                        code={`interface AuthState {
  user: User | null;
  login: (user: User) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  
  const login = (user: User) => setUser(user);
  const logout = () => setUser(null);
  
  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>State Update Patterns</CardTitle>
                                    <CardDescription>Common state update scenarios</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="state-updates"
                                        code={`const [state, setState] = useState({
  name: 'John',
  age: 30,
  settings: { theme: 'dark' }
});

// Update single property
setState(prev => ({ ...prev, name: 'Jane' }));

// Update nested property
setState(prev => ({
  ...prev,
  settings: { ...prev.settings, theme: 'light' }
}));

// Update array state
const [items, setItems] = useState<string[]>([]);

// Add item
setItems(prev => [...prev, newItem]);

// Remove item
setItems(prev => prev.filter((_, i) => i !== index));

// Update item
setItems(prev => prev.map((item, i) => 
  i === index ? newItem : item
));`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Local Storage Sync</CardTitle>
                                    <CardDescription>Persist state to localStorage</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="local-storage"
                                        code={`const useLocalStorage = <T,>(key: string, initialValue: T) => {
  const [value, setValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      return initialValue;
    }
  });
  
  const setStoredValue = (value: T | ((val: T) => T)) => {
    try {
      const valueToStore = value instanceof Function ? value(value) : value;
      setValue(valueToStore);
      window.localStorage.setItem(key, JSON.stringify(valueToStore));
    } catch (error) {
      console.error(error);
    }
  };
  
  return [value, setStoredValue] as const;
};

// Usage
const [theme, setTheme] = useLocalStorage('theme', 'light');`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Form State Management</CardTitle>
                                    <CardDescription>Handling form data</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="form-state"
                                        code={`const Form = () => {
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    remember: false
  });
  
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };
  
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    console.log(formData);
  };
  
  return (
    <form onSubmit={handleSubmit}>
      <input
        name="email"
        value={formData.email}
        onChange={handleChange}
      />
      <input
        type="checkbox"
        name="remember"
        checked={formData.remember}
        onChange={handleChange}
      />
    </form>
  );
};`}
                                    />
                                </CardContent>
                            </Card>
                        </div>
                    </TabsContent>

                    {/* Advanced Tab */}
                    <TabsContent value="advanced">
                        <div className="grid gap-6 md:grid-cols-2">
                            <Card>
                                <CardHeader>
                                    <CardTitle>Error Boundaries</CardTitle>
                                    <CardDescription>Catch React errors gracefully</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="error-boundary"
                                        code={`class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  state = { hasError: false, error: null };
  
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Error:', error, errorInfo);
  }
  
  render() {
    if (this.state.hasError) {
      return <div>Something went wrong!</div>;
    }
    return this.props.children;
  }
}

// Usage
<ErrorBoundary>
  <MyComponent />
</ErrorBoundary>`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Portal</CardTitle>
                                    <CardDescription>Render outside parent DOM</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="portal"
                                        code={`import { createPortal } from 'react-dom';

const Modal = ({ children, isOpen }: Props) => {
  if (!isOpen) return null;
  
  return createPortal(
    <div className="modal-overlay">
      <div className="modal-content">
        {children}
      </div>
    </div>,
    document.getElementById('modal-root')!
  );
};

// Usage
<Modal isOpen={showModal}>
  <h2>Modal Content</h2>
</Modal>`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Lazy Loading</CardTitle>
                                    <CardDescription>Code splitting with React.lazy</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="lazy-loading"
                                        code={`import { lazy, Suspense } from 'react';

// Lazy load component
const HeavyComponent = lazy(() => import('./HeavyComponent'));

const App = () => (
  <Suspense fallback={<div>Loading...</div>}>
    <HeavyComponent />
  </Suspense>
);

// With error boundary
<ErrorBoundary>
  <Suspense fallback={<Spinner />}>
    <LazyComponent />
  </Suspense>
</ErrorBoundary>`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Forward Ref</CardTitle>
                                    <CardDescription>Pass refs to child components</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="forward-ref"
                                        code={`interface InputProps {
  label: string;
  placeholder?: string;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, placeholder }, ref) => {
    return (
      <div>
        <label>{label}</label>
        <input ref={ref} placeholder={placeholder} />
      </div>
    );
  }
);

Input.displayName = 'Input';

// Usage
const Parent = () => {
  const inputRef = useRef<HTMLInputElement>(null);
  
  return (
    <Input 
      ref={inputRef} 
      label="Name" 
      placeholder="Enter name"
    />
  );
};`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>useImperativeHandle</CardTitle>
                                    <CardDescription>Customize ref exposure</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="imperative-handle"
                                        code={`interface VideoHandle {
  play: () => void;
  pause: () => void;
}

const VideoPlayer = forwardRef<VideoHandle>((props, ref) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  
  useImperativeHandle(ref, () => ({
    play: () => videoRef.current?.play(),
    pause: () => videoRef.current?.pause()
  }));
  
  return <video ref={videoRef} />;
});

// Usage
const Parent = () => {
  const playerRef = useRef<VideoHandle>(null);
  
  return (
    <>
      <VideoPlayer ref={playerRef} />
      <button onClick={() => playerRef.current?.play()}>Play</button>
    </>
  );
};`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Performance Optimization</CardTitle>
                                    <CardDescription>React.memo and optimization tips</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="optimization"
                                        code={`// Memoize component
const ExpensiveComponent = React.memo<Props>(({ data }) => {
  return <div>{/* Expensive render */}</div>;
});

// Custom comparison
const areEqual = (prevProps: Props, nextProps: Props) => {
  return prevProps.id === nextProps.id;
};

const OptimizedComponent = React.memo(MyComponent, areEqual);

// useMemo for expensive calculations
const memoizedValue = useMemo(() => {
  return computeExpensiveValue(a, b);
}, [a, b]);

// useCallback for event handlers
const memoizedCallback = useCallback(() => {
  doSomething(a, b);
}, [a, b]);`}
                                    />
                                </CardContent>
                            </Card>
                        </div>
                    </TabsContent>

                    {/* Styling Tab */}
                    <TabsContent value="styling">
                        <div className="grid gap-6 md:grid-cols-2">
                            <Card>
                                <CardHeader>
                                    <CardTitle>Tailwind CSS Classes</CardTitle>
                                    <CardDescription>Common Tailwind patterns</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="tailwind-basics"
                                        code={`// Layout
<div className="flex items-center justify-between">
<div className="grid grid-cols-3 gap-4">
<div className="container mx-auto px-4">

// Typography
<h1 className="text-4xl font-bold text-gray-900">
<p className="text-sm text-gray-600 leading-relaxed">

// Spacing
<div className="p-4 m-2">        {/* padding, margin */}
<div className="px-6 py-3">      {/* x-axis, y-axis */}
<div className="mt-4 mb-2">      {/* top, bottom */}

// Colors & Backgrounds
<div className="bg-blue-500 text-white">
<div className="bg-gradient-to-r from-blue-500 to-purple-600">

// Borders & Shadows
<div className="border border-gray-300 rounded-lg">
<div className="shadow-lg shadow-blue-500/50">

// Responsive Design
<div className="text-sm md:text-base lg:text-lg">
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3">`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Conditional Classes</CardTitle>
                                    <CardDescription>Dynamic class application</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="conditional-classes"
                                        code={`// Template literals
const Button = ({ variant, size }: Props) => {
  return (
    <button
      className={\`
        px-4 py-2 rounded
        \${variant === 'primary' ? 'bg-blue-500' : 'bg-gray-500'}
        \${size === 'large' ? 'text-lg' : 'text-sm'}
      \`}
    >
      Click me
    </button>
  );
};

// Using clsx/classnames library
import clsx from 'clsx';

const Card = ({ isActive, hasError }: Props) => {
  return (
    <div
      className={clsx(
        'p-4 rounded-lg',
        isActive && 'bg-blue-100 border-blue-500',
        hasError && 'bg-red-100 border-red-500',
        !isActive && !hasError && 'bg-gray-100'
      )}
    />
  );
};`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>CSS Modules</CardTitle>
                                    <CardDescription>Component-scoped styles</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="css-modules"
                                        code={`// Component.module.css
.container {
  padding: 1rem;
  background: white;
}

.title {
  font-size: 2rem;
  color: #333;
}

// Component.tsx
import styles from './Component.module.css';

const Component = () => {
  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Title</h1>
    </div>
  );
};

// Combining with global classes
<div className={\`\${styles.container} flex items-center\`}>`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Styled Components Pattern</CardTitle>
                                    <CardDescription>Component styling approaches</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="styling-patterns"
                                        code={`// Variant-based styling
interface ButtonProps {
  variant: 'primary' | 'secondary' | 'danger';
  size: 'sm' | 'md' | 'lg';
}

const buttonStyles = {
  primary: 'bg-blue-500 hover:bg-blue-600',
  secondary: 'bg-gray-500 hover:bg-gray-600',
  danger: 'bg-red-500 hover:bg-red-600'
};

const sizeStyles = {
  sm: 'px-2 py-1 text-sm',
  md: 'px-4 py-2 text-base',
  lg: 'px-6 py-3 text-lg'
};

const Button: React.FC<ButtonProps> = ({ variant, size, children }) => {
  return (
    <button
      className={\`
        rounded font-semibold
        \${buttonStyles[variant]}
        \${sizeStyles[size]}
      \`}
    >
      {children}
    </button>
  );
};`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Dark Mode Toggle</CardTitle>
                                    <CardDescription>Theme switching implementation</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="dark-mode"
                                        code={`const ThemeProvider = ({ children }: Props) => {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
  }, [theme]);
  
  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

// Usage in components
const Component = () => {
  const { theme, setTheme } = useTheme();
  
  return (
    <div className="bg-white dark:bg-gray-900 text-gray-900 dark:text-white">
      <button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
        Toggle Theme
      </button>
    </div>
  );
};`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Animations with Tailwind</CardTitle>
                                    <CardDescription>Adding motion to components</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="animations"
                                        code={`// Built-in animations
<div className="animate-spin">Loading...</div>
<div className="animate-pulse">Pulsing</div>
<div className="animate-bounce">Bouncing</div>

// Transitions
<button className="transition-colors duration-300 hover:bg-blue-600">
  Hover me
</button>

<div className="transition-all duration-500 hover:scale-110">
  Scale on hover
</div>

// Custom animations in tailwind.config.js
{
  theme: {
    extend: {
      animation: {
        'fade-in': 'fadeIn 0.5s ease-in'
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' }
        }
      }
    }
  }
}`}
                                    />
                                </CardContent>
                            </Card>
                        </div>
                    </TabsContent>
                </Tabs>

                {/* Footer */}
                <div className="mt-12 text-center text-slate-600 text-sm">
                    <p>💙 Built with React, TypeScript, Tailwind CSS, and shadcn/ui</p>
                    <p className="mt-2">Keep this cheatsheet handy for your next React project!</p>
                </div>
            </div>
        </div>
    );
};

export default ReactCheatsheet;