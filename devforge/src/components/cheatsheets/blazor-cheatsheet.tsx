import React, { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Code, Component, Zap, Database, Wrench, Globe } from 'lucide-react';

const BlazorCheatsheet = () => {
    const [copiedCode, setCopiedCode] = useState<string | null>(null);

    const copyToClipboard = (code: string, id: string) => {
        navigator.clipboard.writeText(code);
        setCopiedCode(id);
        setTimeout(() => setCopiedCode(null), 2000);
    };

    const CodeBlock = ({ code, id, title, language = 'csharp' }: { code: string; id: string; title?: string; language?: string }) => (
        <div className="relative group">
            {title && <div className="text-sm font-semibold text-slate-700 mb-2">{title}</div>}
            <pre className="bg-slate-900 text-slate-50 p-4 rounded-lg overflow-x-auto scrollable-content text-sm">
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
                        <TabsTrigger value="components" className="gap-2">
                            <Component className="w-4 h-4" />
                            Components
                        </TabsTrigger>
                        <TabsTrigger value="data" className="gap-2">
                            <Database className="w-4 h-4" />
                            Data Binding
                        </TabsTrigger>
                        <TabsTrigger value="lifecycle" className="gap-2">
                            <Zap className="w-4 h-4" />
                            Lifecycle
                        </TabsTrigger>
                        <TabsTrigger value="advanced" className="gap-2">
                            <Wrench className="w-4 h-4" />
                            Advanced
                        </TabsTrigger>
                        <TabsTrigger value="interop" className="gap-2">
                            <Globe className="w-4 h-4" />
                            JS Interop
                        </TabsTrigger>
                    </TabsList>

                    {/* Basics Tab */}
                    <TabsContent value="basics">
                        <div className="grid gap-6 md:grid-cols-2">
                            <Card>
                                <CardHeader>
                                    <CardTitle>Basic Component</CardTitle>
                                    <CardDescription>Simple Blazor component structure</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="basic-comp"
                                        code={`@page "/counter"

<h3>Counter</h3>

<p>Current count: @currentCount</p>

<button class="btn btn-primary" @onclick="IncrementCount">
    Click me
</button>

@code {
    private int currentCount = 0;

    private void IncrementCount()
    {
        currentCount++;
    }
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Component with Parameters</CardTitle>
                                    <CardDescription>Passing data to components</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="params"
                                        code={`<!-- Parent Component -->
<ChildComponent 
    Title="My Title" 
    Count="10" 
    IsEnabled="true" />

<!-- Child Component -->
@code {
    [Parameter]
    public string Title { get; set; } = string.Empty;
    
    [Parameter]
    public int Count { get; set; }
    
    [Parameter]
    public bool IsEnabled { get; set; }
    
    [Parameter]
    public EventCallback<int> OnCountChanged { get; set; }
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Razor Syntax</CardTitle>
                                    <CardDescription>Common Razor expressions</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="razor-syntax"
                                        code={`<!-- Variables -->
@currentCount
@person.Name

<!-- C# Expressions -->
@(DateTime.Now.ToString("yyyy-MM-dd"))
@(price * quantity)

<!-- Code Blocks -->
@{
    var message = "Hello";
    var total = items.Sum(x => x.Price);
}

<!-- Conditional Rendering -->
@if (isLoggedIn)
{
    <p>Welcome back!</p>
}
else
{
    <p>Please log in</p>
}

<!-- Loops -->
@foreach (var item in items)
{
    <li>@item.Name</li>
}

@for (int i = 0; i < 10; i++)
{
    <span>@i</span>
}`}
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
                                        code={`<!-- Click Events -->
<button @onclick="HandleClick">Click</button>
<button @onclick="() => count++">Inline</button>
<button @onclick="@(e => HandleClickWithArgs(e, "data"))">
    With Args
</button>

<!-- Input Events -->
<input @onchange="HandleChange" />
<input @oninput="HandleInput" />
<input @onkeypress="HandleKeyPress" />

<!-- Form Events -->
<form @onsubmit="HandleSubmit">
    <button type="submit">Submit</button>
</form>

<!-- Mouse Events -->
<div @onmouseover="HandleMouseOver"
     @onmouseout="HandleMouseOut">
    Hover me
</div>

@code {
    private void HandleClick()
    {
        Console.WriteLine("Clicked!");
    }
    
    private void HandleChange(ChangeEventArgs e)
    {
        var value = e.Value?.ToString();
    }
    
    private void HandleSubmit()
    {
        // Prevent default is automatic
    }
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Directives</CardTitle>
                                    <CardDescription>Common Blazor directives</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="directives"
                                        code={`<!-- Page Directive -->
@page "/products"
@page "/products/{id:int}"

<!-- Using Directives -->
@using MyApp.Models
@using MyApp.Services

<!-- Inject Services -->
@inject HttpClient Http
@inject NavigationManager NavManager
@inject ILogger<MyComponent> Logger

<!-- Implements Interface -->
@implements IDisposable

<!-- Inherits Base Class -->
@inherits ComponentBase

<!-- Layout -->
@layout MainLayout

<!-- Attribute -->
@attribute [Authorize]
@attribute [AllowAnonymous]

<!-- RenderMode (.NET 8+) -->
@rendermode InteractiveServer
@rendermode InteractiveWebAssembly
@rendermode InteractiveAuto`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Routing</CardTitle>
                                    <CardDescription>Navigation and route parameters</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="routing"
                                        code={`<!-- Route Parameters -->
@page "/product/{id:int}"
@page "/user/{username}"
@page "/blog/{year:int}/{month:int}/{slug}"

@code {
    [Parameter]
    public int Id { get; set; }
    
    [Parameter]
    public string Username { get; set; } = "";
}

<!-- Query Parameters -->
@page "/search"
@inject NavigationManager NavManager

@code {
    [SupplyParameterFromQuery]
    public string? Query { get; set; }
    
    [SupplyParameterFromQuery(Name = "page")]
    public int PageNumber { get; set; } = 1;
}

<!-- Navigation -->
@inject NavigationManager NavManager

@code {
    private void NavigateToProduct(int id)
    {
        NavManager.NavigateTo($"/product/{id}");
    }
    
    private void NavigateWithQueryString()
    {
        NavManager.NavigateTo("/search?query=blazor&page=2");
    }
}`}
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
                                    <CardTitle>RenderFragment</CardTitle>
                                    <CardDescription>Templated components and child content</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="render-fragment"
                                        code={`<!-- Parent Component -->
<CardComponent>
    <Header>
        <h3>Card Title</h3>
    </Header>
    <Body>
        <p>Card content goes here</p>
    </Body>
</CardComponent>

<!-- CardComponent.razor -->
<div class="card">
    <div class="card-header">
        @Header
    </div>
    <div class="card-body">
        @Body
    </div>
</div>

@code {
    [Parameter]
    public RenderFragment? Header { get; set; }
    
    [Parameter]
    public RenderFragment? Body { get; set; }
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Generic Components</CardTitle>
                                    <CardDescription>Type-safe reusable components</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="generic"
                                        code={`<!-- Usage -->
<DataList Items="products" TItem="Product">
    <ItemTemplate Context="product">
        <div>@product.Name - @product.Price</div>
    </ItemTemplate>
</DataList>

<!-- DataList.razor -->
@typeparam TItem

<div class="data-list">
    @if (Items != null)
    {
        @foreach (var item in Items)
        {
            @ItemTemplate(item)
        }
    }
</div>

@code {
    [Parameter]
    public IEnumerable<TItem>? Items { get; set; }
    
    [Parameter]
    public RenderFragment<TItem>? ItemTemplate { get; set; }
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Cascading Values</CardTitle>
                                    <CardDescription>Sharing data across component hierarchy</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="cascading"
                                        code={`<!-- Parent Component -->
<CascadingValue Value="currentUser">
    <CascadingValue Value="theme" Name="AppTheme">
        <ChildComponent />
    </CascadingValue>
</CascadingValue>

@code {
    private User currentUser = new User { Name = "John" };
    private string theme = "dark";
}

<!-- Child Component (any level deep) -->
@code {
    [CascadingParameter]
    public User CurrentUser { get; set; } = null!;
    
    [CascadingParameter(Name = "AppTheme")]
    public string Theme { get; set; } = "";
    
    protected override void OnInitialized()
    {
        Console.WriteLine($"User: {CurrentUser.Name}");
        Console.WriteLine($"Theme: {Theme}");
    }
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Component Reference</CardTitle>
                                    <CardDescription>Accessing child component methods</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="component-ref"
                                        code={`<!-- Parent Component -->
<ChildComponent @ref="childComponent" />

<button @onclick="CallChildMethod">
    Call Child Method
</button>

@code {
    private ChildComponent childComponent = null!;
    
    private void CallChildMethod()
    {
        childComponent.PublicMethod();
    }
}

<!-- Child Component -->
@code {
    public void PublicMethod()
    {
        Console.WriteLine("Called from parent!");
    }
    
    private void PrivateMethod()
    {
        // Not accessible from parent
    }
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>EventCallback</CardTitle>
                                    <CardDescription>Child-to-parent communication</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="event-callback"
                                        code={`<!-- Parent Component -->
<ChildComponent OnValueChanged="HandleValueChanged" />

<p>Value from child: @childValue</p>

@code {
    private string childValue = "";
    
    private void HandleValueChanged(string value)
    {
        childValue = value;
    }
}

<!-- Child Component -->
<input @bind="currentValue" @bind:event="oninput" />
<button @onclick="NotifyParent">Send to Parent</button>

@code {
    private string currentValue = "";
    
    [Parameter]
    public EventCallback<string> OnValueChanged { get; set; }
    
    private async Task NotifyParent()
    {
        await OnValueChanged.InvokeAsync(currentValue);
    }
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Code-Behind Pattern</CardTitle>
                                    <CardDescription>Separating markup from logic</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="code-behind"
                                        code={`<!-- Counter.razor -->
@inherits CounterBase

<h3>Counter</h3>
<p>Count: @CurrentCount</p>
<button @onclick="IncrementCount">Increment</button>

<!-- Counter.razor.cs -->
namespace MyApp.Pages
{
    public partial class CounterBase : ComponentBase
    {
        protected int CurrentCount { get; set; } = 0;
        
        [Inject]
        protected ILogger<CounterBase> Logger { get; set; } = null!;
        
        protected void IncrementCount()
        {
            CurrentCount++;
            Logger.LogInformation($"Count: {CurrentCount}");
        }
        
        protected override void OnInitialized()
        {
            // Initialization logic
        }
    }
}`}
                                    />
                                </CardContent>
                            </Card>
                        </div>
                    </TabsContent>

                    {/* Data Binding Tab */}
                    <TabsContent value="data">
                        <div className="grid gap-6 md:grid-cols-2">
                            <Card>
                                <CardHeader>
                                    <CardTitle>Data Binding</CardTitle>
                                    <CardDescription>One-way and two-way binding</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="binding"
                                        code={`<!-- One-way Binding -->
<input value="@name" />

<!-- Two-way Binding -->
<input @bind="name" />
<input @bind="age" />
<input type="checkbox" @bind="isChecked" />

<!-- Bind with Event -->
<input @bind="name" @bind:event="oninput" />

<!-- Bind with Format -->
<input @bind="startDate" @bind:format="yyyy-MM-dd" />
<input @bind="price" @bind:format="C2" />

<!-- Bind to Complex Object -->
<input @bind="person.FirstName" />
<input @bind="person.LastName" />
<input @bind="person.Email" />

@code {
    private string name = "";
    private int age = 0;
    private bool isChecked = false;
    private DateTime startDate = DateTime.Now;
    private decimal price = 0;
    
    private Person person = new Person();
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Forms and Validation</CardTitle>
                                    <CardDescription>EditForm and validation</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="forms"
                                        code={`<EditForm Model="person" OnValidSubmit="HandleValidSubmit">
    <DataAnnotationsValidator />
    <ValidationSummary />
    
    <div class="form-group">
        <label>Name:</label>
        <InputText @bind-Value="person.Name" class="form-control" />
        <ValidationMessage For="@(() => person.Name)" />
    </div>
    
    <div class="form-group">
        <label>Email:</label>
        <InputText @bind-Value="person.Email" class="form-control" />
        <ValidationMessage For="@(() => person.Email)" />
    </div>
    
    <div class="form-group">
        <label>Age:</label>
        <InputNumber @bind-Value="person.Age" class="form-control" />
        <ValidationMessage For="@(() => person.Age)" />
    </div>
    
    <div class="form-group">
        <label>Birth Date:</label>
        <InputDate @bind-Value="person.BirthDate" class="form-control" />
    </div>
    
    <div class="form-group">
        <InputCheckbox @bind-Value="person.AcceptTerms" />
        <label>Accept Terms</label>
    </div>
    
    <button type="submit" class="btn btn-primary">Submit</button>
</EditForm>

@code {
    private Person person = new Person();
    
    private void HandleValidSubmit()
    {
        Console.WriteLine("Form submitted successfully!");
    }
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Data Annotations</CardTitle>
                                    <CardDescription>Model validation attributes</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="validation"
                                        code={`using System.ComponentModel.DataAnnotations;

public class Person
{
    [Required(ErrorMessage = "Name is required")]
    [StringLength(50, MinimumLength = 2,
        ErrorMessage = "Name must be 2-50 characters")]
    public string Name { get; set; } = "";
    
    [Required]
    [EmailAddress(ErrorMessage = "Invalid email address")]
    public string Email { get; set; } = "";
    
    [Range(18, 120, ErrorMessage = "Age must be 18-120")]
    public int Age { get; set; }
    
    [Phone]
    public string? PhoneNumber { get; set; }
    
    [Url]
    public string? Website { get; set; }
    
    [Compare(nameof(Email), 
        ErrorMessage = "Emails must match")]
    public string ConfirmEmail { get; set; } = "";
    
    [RegularExpression(@"^[A-Z]{2}\d{4}$",
        ErrorMessage = "Invalid format")]
    public string Code { get; set; } = "";
    
    [CreditCard]
    public string? CreditCard { get; set; }
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Custom Validation</CardTitle>
                                    <CardDescription>Creating custom validators</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="custom-validation"
                                        code={`// Custom Attribute
public class MinimumAgeAttribute : ValidationAttribute
{
    private readonly int _minimumAge;
    
    public MinimumAgeAttribute(int minimumAge)
    {
        _minimumAge = minimumAge;
    }
    
    protected override ValidationResult? IsValid(
        object? value, ValidationContext validationContext)
    {
        if (value is DateTime birthDate)
        {
            var age = DateTime.Today.Year - birthDate.Year;
            if (age < _minimumAge)
            {
                return new ValidationResult(
                    $"Must be at least {_minimumAge} years old");
            }
        }
        return ValidationResult.Success;
    }
}

// Usage
public class Person
{
    [MinimumAge(18)]
    public DateTime BirthDate { get; set; }
}

// IValidatableObject
public class Person : IValidatableObject
{
    public string Password { get; set; } = "";
    public string ConfirmPassword { get; set; } = "";
    
    public IEnumerable<ValidationResult> Validate(
        ValidationContext validationContext)
    {
        if (Password != ConfirmPassword)
        {
            yield return new ValidationResult(
                "Passwords do not match",
                new[] { nameof(ConfirmPassword) });
        }
    }
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Select and Dropdowns</CardTitle>
                                    <CardDescription>Working with select inputs</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="select"
                                        code={`<!-- Simple Select -->
<InputSelect @bind-Value="selectedColor" class="form-control">
    <option value="">-- Select Color --</option>
    <option value="red">Red</option>
    <option value="blue">Blue</option>
    <option value="green">Green</option>
</InputSelect>

<!-- Enum Select -->
<InputSelect @bind-Value="priority" class="form-control">
    @foreach (var value in Enum.GetValues<Priority>())
    {
        <option value="@value">@value</option>
    }
</InputSelect>

<!-- List Select -->
<InputSelect @bind-Value="selectedProductId" class="form-control">
    <option value="0">-- Select Product --</option>
    @foreach (var product in products)
    {
        <option value="@product.Id">@product.Name</option>
    }
</InputSelect>

@code {
    private string selectedColor = "";
    private Priority priority = Priority.Medium;
    private int selectedProductId = 0;
    private List<Product> products = new();
    
    public enum Priority { Low, Medium, High }
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>File Upload</CardTitle>
                                    <CardDescription>Handling file uploads</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="file-upload"
                                        code={`<InputFile OnChange="HandleFileSelected" multiple />

@if (isLoading)
{
    <p>Uploading...</p>
}

@code {
    private bool isLoading = false;
    
    private async Task HandleFileSelected(InputFileChangeEventArgs e)
    {
        isLoading = true;
        
        try
        {
            foreach (var file in e.GetMultipleFiles(maxFiles: 10))
            {
                // Get file info
                var fileName = file.Name;
                var fileSize = file.Size;
                var contentType = file.ContentType;
                
                // Read file content
                using var stream = file.OpenReadStream(
                    maxAllowedSize: 10 * 1024 * 1024); // 10MB
                    
                var buffer = new byte[file.Size];
                await stream.ReadAsync(buffer);
                
                // Upload to server
                // await UploadFile(fileName, buffer);
            }
        }
        finally
        {
            isLoading = false;
        }
    }
}`}
                                    />
                                </CardContent>
                            </Card>
                        </div>
                    </TabsContent>

                    {/* Lifecycle Tab */}
                    <TabsContent value="lifecycle">
                        <div className="grid gap-6 md:grid-cols-2">
                            <Card>
                                <CardHeader>
                                    <CardTitle>Lifecycle Methods</CardTitle>
                                    <CardDescription>Component lifecycle hooks</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="lifecycle"
                                        code={`@implements IDisposable

@code {
    // 1. SetParametersAsync (first)
    public override Task SetParametersAsync(ParameterView parameters)
    {
        // Set parameters manually if needed
        return base.SetParametersAsync(parameters);
    }
    
    // 2. OnInitialized (sync)
    protected override void OnInitialized()
    {
        // Initialize component
        // Runs once when component is created
    }
    
    // 3. OnInitializedAsync (async)
    protected override async Task OnInitializedAsync()
    {
        // Async initialization
        // Load data from API
        await LoadDataAsync();
    }
    
    // 4. OnParametersSet (sync)
    protected override void OnParametersSet()
    {
        // React to parameter changes
        // Runs after OnInitialized
    }
    
    // 5. OnParametersSetAsync (async)
    protected override async Task OnParametersSetAsync()
    {
        // Async parameter handling
        await ValidateParametersAsync();
    }
    
    // 6. OnAfterRender (sync)
    protected override void OnAfterRender(bool firstRender)
    {
        if (firstRender)
        {
            // Run once after first render
            // Use for JS interop
        }
        // Runs after every render
    }
    
    // 7. OnAfterRenderAsync (async)
    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender)
        {
            await JS.InvokeVoidAsync("initializeComponent");
        }
    }
    
    // 8. Dispose
    public void Dispose()
    {
        // Cleanup: unsubscribe events, dispose resources
    }
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>StateHasChanged</CardTitle>
                                    <CardDescription>Manual re-rendering</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="state-changed"
                                        code={`@code {
    private int count = 0;
    
    protected override async Task OnInitializedAsync()
    {
        // Background task
        _ = Task.Run(async () =>
        {
            while (true)
            {
                await Task.Delay(1000);
                count++;
                
                // Notify Blazor to re-render
                await InvokeAsync(StateHasChanged);
            }
        });
    }
    
    private async Task LongRunningOperation()
    {
        // Do some work
        await Task.Delay(1000);
        
        // Update UI
        StateHasChanged();
        
        // Do more work
        await Task.Delay(1000);
        
        // Update UI again
        StateHasChanged();
    }
    
    // ShouldRender for optimization
    protected override bool ShouldRender()
    {
        // Return false to prevent re-rendering
        return count % 2 == 0;
    }
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Dependency Injection</CardTitle>
                                    <CardDescription>Injecting services</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="di"
                                        code={`<!-- Component -->
@inject HttpClient Http
@inject NavigationManager NavManager
@inject ILogger<MyComponent> Logger
@inject IConfiguration Config
@inject AuthenticationStateProvider AuthProvider
@inject IJSRuntime JS

@code {
    // Alternative: Property Injection
    [Inject]
    private IMyService MyService { get; set; } = null!;
    
    protected override async Task OnInitializedAsync()
    {
        // Use injected services
        var data = await Http.GetFromJsonAsync<Data[]>("/api/data");
        Logger.LogInformation("Data loaded");
    }
}

// Register services in Program.cs
builder.Services.AddScoped<IMyService, MyService>();
builder.Services.AddSingleton<IConfigService, ConfigService>();
builder.Services.AddTransient<IEmailService, EmailService>();

// HttpClient
builder.Services.AddScoped(sp => 
    new HttpClient 
    { 
        BaseAddress = new Uri(builder.HostEnvironment.BaseAddress) 
    });`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Error Handling</CardTitle>
                                    <CardDescription>Error boundaries and handling</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="error-handling"
                                        code={`<!-- ErrorBoundary -->
<ErrorBoundary>
    <ChildContent>
        <MyComponent />
    </ChildContent>
    <ErrorContent Context="exception">
        <div class="alert alert-danger">
            <h4>Error occurred!</h4>
            <p>@exception.Message</p>
        </div>
    </ErrorContent>
</ErrorBoundary>

<!-- Try-Catch in Component -->
@code {
    private string? errorMessage;
    
    protected override async Task OnInitializedAsync()
    {
        try
        {
            await LoadDataAsync();
        }
        catch (HttpRequestException ex)
        {
            errorMessage = $"Network error: {ex.Message}";
            Logger.LogError(ex, "Failed to load data");
        }
        catch (Exception ex)
        {
            errorMessage = "An unexpected error occurred";
            Logger.LogError(ex, "Unexpected error");
        }
    }
}

@if (errorMessage != null)
{
    <div class="alert alert-danger">@errorMessage</div>
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Async Operations</CardTitle>
                                    <CardDescription>Loading states and async patterns</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="async"
                                        code={`@code {
    private List<Product>? products;
    private bool isLoading = true;
    private string? errorMessage;
    
    protected override async Task OnInitializedAsync()
    {
        await LoadProductsAsync();
    }
    
    private async Task LoadProductsAsync()
    {
        isLoading = true;
        errorMessage = null;
        
        try
        {
            products = await Http.GetFromJsonAsync<List<Product>>(
                "/api/products");
        }
        catch (Exception ex)
        {
            errorMessage = ex.Message;
        }
        finally
        {
            isLoading = false;
        }
    }
}

@if (isLoading)
{
    <p>Loading...</p>
}
else if (errorMessage != null)
{
    <div class="alert alert-danger">@errorMessage</div>
}
else if (products != null && products.Any())
{
    @foreach (var product in products)
    {
        <div>@product.Name</div>
    }
}
else
{
    <p>No products found</p>
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Timer and Intervals</CardTitle>
                                    <CardDescription>Periodic updates</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="timer"
                                        code={`@implements IDisposable

<p>Current time: @currentTime.ToString("HH:mm:ss")</p>
<p>Counter: @counter</p>

@code {
    private DateTime currentTime = DateTime.Now;
    private int counter = 0;
    private Timer? timer;
    
    protected override void OnInitialized()
    {
        // Create timer that fires every second
        timer = new Timer(async _ =>
        {
            currentTime = DateTime.Now;
            counter++;
            
            // Update UI
            await InvokeAsync(StateHasChanged);
            
        }, null, TimeSpan.Zero, TimeSpan.FromSeconds(1));
    }
    
    public void Dispose()
    {
        timer?.Dispose();
    }
}

// Using PeriodicTimer (.NET 6+)
@code {
    private CancellationTokenSource? cts;
    
    protected override async Task OnInitializedAsync()
    {
        cts = new CancellationTokenSource();
        await RunPeriodicAsync(cts.Token);
    }
    
    private async Task RunPeriodicAsync(CancellationToken token)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        
        while (await timer.WaitForNextTickAsync(token))
        {
            counter++;
            StateHasChanged();
        }
    }
    
    public void Dispose()
    {
        cts?.Cancel();
        cts?.Dispose();
    }
}`}
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
                                    <CardTitle>Virtualization</CardTitle>
                                    <CardDescription>Efficient rendering of large lists</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="virtualize"
                                        code={`<!-- Basic Virtualization -->
<Virtualize Items="items" Context="item">
    <div class="item">
        @item.Name
    </div>
</Virtualize>

<!-- With ItemSize -->
<Virtualize Items="items" ItemSize="50" Context="item">
    <div class="item" style="height: 50px;">
        @item.Name
    </div>
</Virtualize>

<!-- Async ItemsProvider -->
<Virtualize ItemsProvider="LoadItemsAsync" Context="item">
    <ItemContent>
        <div>@item.Name</div>
    </ItemContent>
    <Placeholder>
        <div>Loading...</div>
    </Placeholder>
</Virtualize>

@code {
    private List<Item> items = Enumerable
        .Range(1, 10000)
        .Select(i => new Item { Id = i, Name = $"Item {i}" })
        .ToList();
    
    private async ValueTask<ItemsProviderResult<Item>> 
        LoadItemsAsync(ItemsProviderRequest request)
    {
        // Simulate API call
        await Task.Delay(100);
        
        var items = await GetItemsAsync(
            request.StartIndex, 
            request.Count);
            
        return new ItemsProviderResult<Item>(
            items, 
            totalItemCount: 10000);
    }
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>RenderFragment Delegates</CardTitle>
                                    <CardDescription>Dynamic content generation</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="render-delegate"
                                        code={`@code {
    private RenderFragment CreateDynamicComponent(string title) => builder =>
    {
        var sequence = 0;
        
        builder.OpenElement(sequence++, "div");
        builder.AddAttribute(sequence++, "class", "card");
        
        builder.OpenElement(sequence++, "h3");
        builder.AddContent(sequence++, title);
        builder.CloseElement();
        
        builder.OpenElement(sequence++, "p");
        builder.AddContent(sequence++, "Dynamic content");
        builder.CloseElement();
        
        builder.CloseElement();
    };
    
    private RenderFragment BuildList(List<string> items) => builder =>
    {
        var sequence = 0;
        
        builder.OpenElement(sequence++, "ul");
        
        foreach (var item in items)
        {
            builder.OpenElement(sequence++, "li");
            builder.AddContent(sequence++, item);
            builder.CloseElement();
        }
        
        builder.CloseElement();
    };
}

<!-- Usage -->
@CreateDynamicComponent("My Title")
@BuildList(new List<string> { "A", "B", "C" })`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Authentication</CardTitle>
                                    <CardDescription>User authentication and authorization</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="auth"
                                        code={`<!-- App.razor -->
<CascadingAuthenticationState>
    <Router AppAssembly="@typeof(App).Assembly">
        <Found Context="routeData">
            <AuthorizeRouteView RouteData="@routeData" 
                                DefaultLayout="@typeof(MainLayout)">
                <NotAuthorized>
                    <h3>Not authorized</h3>
                </NotAuthorized>
            </AuthorizeRouteView>
        </Found>
    </Router>
</CascadingAuthenticationState>

<!-- Component with Authorization -->
@attribute [Authorize]
@attribute [Authorize(Roles = "Admin")]
@attribute [Authorize(Policy = "Over18")]

<!-- AuthorizeView -->
<AuthorizeView>
    <Authorized>
        <p>Hello, @context.User.Identity?.Name!</p>
    </Authorized>
    <NotAuthorized>
        <p>Please log in</p>
    </NotAuthorized>
</AuthorizeView>

<AuthorizeView Roles="Admin">
    <Authorized>
        <button>Admin Panel</button>
    </Authorized>
</AuthorizeView>

@code {
    [CascadingParameter]
    private Task<AuthenticationState>? AuthState { get; set; }
    
    protected override async Task OnInitializedAsync()
    {
        var authState = await AuthState!;
        var user = authState.User;
        
        if (user.Identity?.IsAuthenticated == true)
        {
            var userName = user.Identity.Name;
            var isAdmin = user.IsInRole("Admin");
        }
    }
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>State Management</CardTitle>
                                    <CardDescription>AppState and state container pattern</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="state-management"
                                        code={`// AppState.cs
public class AppState
{
    private string? currentUser;
    
    public string? CurrentUser
    {
        get => currentUser;
        set
        {
            currentUser = value;
            NotifyStateChanged();
        }
    }
    
    public event Action? OnChange;
    
    private void NotifyStateChanged() => OnChange?.Invoke();
}

// Program.cs
builder.Services.AddScoped<AppState>();

// Component
@inject AppState AppState
@implements IDisposable

<p>Current user: @AppState.CurrentUser</p>

<button @onclick="UpdateUser">Update User</button>

@code {
    protected override void OnInitialized()
    {
        AppState.OnChange += StateHasChanged;
    }
    
    private void UpdateUser()
    {
        AppState.CurrentUser = "New User";
    }
    
    public void Dispose()
    {
        AppState.OnChange -= StateHasChanged;
    }
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>LocalStorage</CardTitle>
                                    <CardDescription>Persisting data in browser</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="localstorage"
                                        code={`@inject IJSRuntime JS

@code {
    // Save to LocalStorage
    private async Task SaveToLocalStorage<T>(string key, T value)
    {
        var json = JsonSerializer.Serialize(value);
        await JS.InvokeVoidAsync("localStorage.setItem", key, json);
    }
    
    // Load from LocalStorage
    private async Task<T?> LoadFromLocalStorage<T>(string key)
    {
        var json = await JS.InvokeAsync<string>(
            "localStorage.getItem", key);
            
        return json == null 
            ? default 
            : JsonSerializer.Deserialize<T>(json);
    }
    
    // Remove from LocalStorage
    private async Task RemoveFromLocalStorage(string key)
    {
        await JS.InvokeVoidAsync("localStorage.removeItem", key);
    }
    
    // Clear LocalStorage
    private async Task ClearLocalStorage()
    {
        await JS.InvokeVoidAsync("localStorage.clear");
    }
    
    // Usage
    protected override async Task OnInitializedAsync()
    {
        // Load user preferences
        var theme = await LoadFromLocalStorage<string>("theme");
        
        // Save settings
        await SaveToLocalStorage("settings", new Settings 
        { 
            Theme = "dark" 
        });
    }
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>SignalR Integration</CardTitle>
                                    <CardDescription>Real-time communication</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="signalr"
                                        code={`@inject NavigationManager NavManager
@implements IAsyncDisposable

<ul>
    @foreach (var message in messages)
    {
        <li>@message</li>
    }
</ul>

<input @bind="messageInput" />
<button @onclick="SendMessage">Send</button>

@code {
    private HubConnection? hubConnection;
    private List<string> messages = new();
    private string messageInput = "";
    
    protected override async Task OnInitializedAsync()
    {
        hubConnection = new HubConnectionBuilder()
            .WithUrl(NavManager.ToAbsoluteUri("/chathub"))
            .Build();
        
        hubConnection.On<string>("ReceiveMessage", message =>
        {
            messages.Add(message);
            StateHasChanged();
        });
        
        await hubConnection.StartAsync();
    }
    
    private async Task SendMessage()
    {
        if (hubConnection is not null && !string.IsNullOrEmpty(messageInput))
        {
            await hubConnection.SendAsync("SendMessage", messageInput);
            messageInput = "";
        }
    }
    
    public async ValueTask DisposeAsync()
    {
        if (hubConnection is not null)
        {
            await hubConnection.DisposeAsync();
        }
    }
}`}
                                    />
                                </CardContent>
                            </Card>
                        </div>
                    </TabsContent>

                    {/* JS Interop Tab */}
                    <TabsContent value="interop">
                        <div className="grid gap-6 md:grid-cols-2">
                            <Card>
                                <CardHeader>
                                    <CardTitle>JavaScript Interop</CardTitle>
                                    <CardDescription>Calling JavaScript from C#</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="js-interop"
                                        code={`@inject IJSRuntime JS

@code {
    // Invoke JavaScript function
    private async Task CallJavaScript()
    {
        await JS.InvokeVoidAsync("alert", "Hello from Blazor!");
    }
    
    // Get return value
    private async Task<string> GetFromJavaScript()
    {
        return await JS.InvokeAsync<string>(
            "prompt", "Enter your name:");
    }
    
    // Complex data
    private async Task PassComplexData()
    {
        var data = new 
        { 
            Name = "John", 
            Age = 30,
            Items = new[] { 1, 2, 3 }
        };
        
        await JS.InvokeVoidAsync("myFunction", data);
    }
    
    // With timeout
    private async Task CallWithTimeout()
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        
        try
        {
            await JS.InvokeVoidAsync("longRunningFunction", cts.Token);
        }
        catch (TaskCanceledException)
        {
            Console.WriteLine("Operation timed out");
        }
    }
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>JavaScript to C#</CardTitle>
                                    <CardDescription>Calling C# from JavaScript</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="js-to-csharp"
                                        code={`// Component
@code {
    [JSInvokable]
    public static Task<string> GetMessage()
    {
        return Task.FromResult("Hello from C#!");
    }
    
    [JSInvokable("CustomMethodName")]
    public async Task<int> CalculateAsync(int x, int y)
    {
        await Task.Delay(100);
        return x + y;
    }
}

// JavaScript
// Static method
DotNet.invokeMethodAsync('MyApp', 'GetMessage')
    .then(message => console.log(message));

// Instance method
var dotNetRef = DotNet.createObjectReference(componentInstance);
dotNetRef.invokeMethodAsync('CustomMethodName', 5, 10)
    .then(result => console.log(result));

// Dispose when done
dotNetRef.dispose();

// In Component
@code {
    private DotNetObjectReference<MyComponent>? objRef;
    
    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender)
        {
            objRef = DotNetObjectReference.Create(this);
            await JS.InvokeVoidAsync("initComponent", objRef);
        }
    }
    
    public void Dispose()
    {
        objRef?.Dispose();
    }
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Custom JavaScript Module</CardTitle>
                                    <CardDescription>Importing JS modules</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="js-module"
                                        code={`// wwwroot/js/myModule.js
export function showAlert(message) {
    alert(message);
}

export function getWindowSize() {
    return {
        width: window.innerWidth,
        height: window.innerHeight
    };
}

// Component
@inject IJSRuntime JS
@implements IAsyncDisposable

@code {
    private IJSObjectReference? module;
    
    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender)
        {
            module = await JS.InvokeAsync<IJSObjectReference>(
                "import", "./js/myModule.js");
        }
    }
    
    private async Task UseModule()
    {
        if (module is not null)
        {
            await module.InvokeVoidAsync("showAlert", "Hello!");
            
            var size = await module.InvokeAsync<WindowSize>(
                "getWindowSize");
                
            Console.WriteLine($"Width: {size.Width}");
        }
    }
    
    public async ValueTask DisposeAsync()
    {
        if (module is not null)
        {
            await module.DisposeAsync();
        }
    }
    
    private class WindowSize
    {
        public int Width { get; set; }
        public int Height { get; set; }
    }
}`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>DOM Manipulation</CardTitle>
                                    <CardDescription>Working with DOM elements</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="dom"
                                        code={`<div @ref="myDiv">Content</div>
<input @ref="myInput" />

@code {
    private ElementReference myDiv;
    private ElementReference myInput;
    
    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender)
        {
            // Focus input
            await myInput.FocusAsync();
            
            // Get element info
            var width = await JS.InvokeAsync<int>(
                "eval", 
                $"document.querySelector('[_bl_{myDiv.Id}]').offsetWidth"
            );
            
            // Scroll to element
            await JS.InvokeVoidAsync(
                "eval",
                $"document.querySelector('[_bl_{myDiv.Id}]').scrollIntoView();"
            );
        }
    }
}

// wwwroot/js/domHelper.js
export function focusElement(element) {
    element.focus();
}

export function getElementDimensions(element) {
    const rect = element.getBoundingClientRect();
    return {
        width: rect.width,
        height: rect.height,
        top: rect.top,
        left: rect.left
    };
}

// Component usage
await module.InvokeVoidAsync("focusElement", myInput);
var dims = await module.InvokeAsync<Dimensions>(
    "getElementDimensions", myDiv);`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Browser APIs</CardTitle>
                                    <CardDescription>Accessing browser features</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="browser-apis"
                                        code={`@inject IJSRuntime JS

@code {
    // Geolocation
    private async Task GetLocation()
    {
        var position = await JS.InvokeAsync<Position>(
            "eval",
            @"new Promise((resolve) => {
                navigator.geolocation.getCurrentPosition(pos => {
                    resolve({
                        latitude: pos.coords.latitude,
                        longitude: pos.coords.longitude
                    });
                });
            })"
        );
    }
    
    // Clipboard
    private async Task CopyToClipboard(string text)
    {
        await JS.InvokeVoidAsync("navigator.clipboard.writeText", text);
    }
    
    // Notification
    private async Task ShowNotification(string title, string body)
    {
        await JS.InvokeVoidAsync("eval", 
            $@"if (Notification.permission === 'granted') {{
                new Notification('{title}', {{ body: '{body}' }});
            }} else {{
                Notification.requestPermission();
            }}"
        );
    }
    
    // Download file
    private async Task DownloadFile(byte[] data, string fileName)
    {
        var base64 = Convert.ToBase64String(data);
        await JS.InvokeVoidAsync("downloadFile", fileName, base64);
    }
}

// wwwroot/index.html
window.downloadFile = (filename, base64) => {
    const blob = base64ToBlob(base64);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
};`}
                                    />
                                </CardContent>
                            </Card>

                            <Card>
                                <CardHeader>
                                    <CardTitle>Third-Party Libraries</CardTitle>
                                    <CardDescription>Integrating JavaScript libraries</CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <CodeBlock
                                        id="third-party"
                                        code={`<!-- index.html -->
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

<!-- Component -->
<canvas @ref="chartCanvas"></canvas>

@inject IJSRuntime JS

@code {
    private ElementReference chartCanvas;
    
    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (firstRender)
        {
            await JS.InvokeVoidAsync("initChart", chartCanvas, 
                new
                {
                    type = "bar",
                    data = new
                    {
                        labels = new[] { "Jan", "Feb", "Mar" },
                        datasets = new[]
                        {
                            new
                            {
                                label = "Sales",
                                data = new[] { 12, 19, 3 }
                            }
                        }
                    }
                });
        }
    }
}

// wwwroot/js/charts.js
window.initChart = (canvas, config) => {
    new Chart(canvas, config);
};`}
                                    />
                                </CardContent>
                            </Card>
                        </div>
                    </TabsContent>
                </Tabs>

            </div>
        </div>
    );
};

export default BlazorCheatsheet;