using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using PdfReaderApp;
using PdfReaderApp.Services;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

builder.Services.AddScoped(sp => new HttpClient { BaseAddress = new Uri(builder.HostEnvironment.BaseAddress) });
builder.Services.AddScoped<PdfInterop>();
builder.Services.AddScoped<SpeechInterop>();
builder.Services.AddScoped<AudioExportService>();
builder.Services.AddScoped<OcrService>();

await builder.Build().RunAsync();
