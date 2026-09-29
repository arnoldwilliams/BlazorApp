using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using PdfReaderApp;
using PdfReaderApp.Services;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

builder.Services.AddScoped(sp => new HttpClient { BaseAddress = new Uri(builder.HostEnvironment.BaseAddress) });
builder.Services.AddScoped<PdfInterop>();
builder.Services.AddScoped<DocxInterop>();
builder.Services.AddScoped<ActiveDocumentSource>();
builder.Services.AddScoped<SpeechInterop>();
builder.Services.AddScoped<AudioExportService>();

await builder.Build().RunAsync();
