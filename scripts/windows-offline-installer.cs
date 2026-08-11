using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

[assembly: AssemblyTitle("Codex ChatGPT Web Setup")]
[assembly: AssemblyProduct("Codex ChatGPT Web")]
[assembly: AssemblyVersion("0.2.8.0")]
[assembly: AssemblyFileVersion("0.2.8.0")]

internal static class OfflineInstaller
{
    private const string RuntimeResource = "CodexChatGptWeb.Runtime.zip";
    private const string InstallerResource = "CodexChatGptWeb.Install.ps1";
    private const string LicenseResource = "CodexChatGptWeb.LICENSE";
    private const string NoticeResource = "CodexChatGptWeb.NOTICE.md";
    private const string OpenCodexLicenseResource = "CodexChatGptWeb.OpenCodex-MIT.txt";
    private const string BunLicenseResource = "CodexChatGptWeb.Bun-1.3.11.md";
    private const string ThirdPartyResource = "CodexChatGptWeb.THIRD_PARTY_NOTICES.txt";
    private const string WindowsSetupResource = "CodexChatGptWeb.WINDOWS_SETUP.md";

    private sealed class InstallerOptions
    {
        public bool Quiet;
        public bool NoLaunch;
        public bool NoPath;
        public bool NoDesktopShortcut;
        public bool NoShortcuts;
        public bool NoRegister;
        public string BinDir;
        public string LibDir;
        public string DocDir;
        public string AppHome;
    }

    private sealed class InstallResult
    {
        public int ExitCode;
        public string Output;
    }

    private sealed class SetupForm : Form
    {
        private readonly InstallerOptions options;
        private readonly Label heading;
        private readonly Label detail;
        private readonly CheckBox desktopShortcut;
        private readonly CheckBox launchGui;
        private readonly ProgressBar progress;
        private readonly Button primary;
        private readonly Button cancel;
        private bool installing;
        private bool installed;

        public int ResultCode { get; private set; }

        public SetupForm(InstallerOptions options)
        {
            this.options = options;
            ResultCode = 0;
            Text = "Codex ChatGPT Web Setup";
            ClientSize = new Size(560, 300);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

            heading = new Label();
            heading.AutoSize = false;
            heading.Font = new Font(Font.FontFamily, 16F, FontStyle.Bold);
            heading.Location = new Point(28, 24);
            heading.Size = new Size(500, 38);
            heading.Text = "Install Codex ChatGPT Web";
            Controls.Add(heading);

            detail = new Label();
            detail.AutoSize = false;
            detail.Location = new Point(30, 74);
            detail.Size = new Size(500, 76);
            detail.Text =
                "Installs for your Windows account without administrator access. " +
                "No service, scheduled task, Run key, or automatic login startup is created.";
            Controls.Add(detail);

            desktopShortcut = new CheckBox();
            desktopShortcut.AutoSize = true;
            desktopShortcut.Checked = !options.NoDesktopShortcut;
            desktopShortcut.Location = new Point(32, 156);
            desktopShortcut.Text = "Create a desktop shortcut";
            Controls.Add(desktopShortcut);

            launchGui = new CheckBox();
            launchGui.AutoSize = true;
            launchGui.Checked = !options.NoLaunch;
            launchGui.Location = new Point(32, 156);
            launchGui.Text = "Launch Codex ChatGPT Web now";
            launchGui.Visible = false;
            Controls.Add(launchGui);

            progress = new ProgressBar();
            progress.Location = new Point(32, 190);
            progress.Size = new Size(496, 18);
            progress.Style = ProgressBarStyle.Marquee;
            progress.MarqueeAnimationSpeed = 35;
            progress.Visible = false;
            Controls.Add(progress);

            primary = new Button();
            primary.Location = new Point(349, 244);
            primary.Size = new Size(86, 30);
            primary.Text = "Install";
            primary.Click += PrimaryClick;
            Controls.Add(primary);

            cancel = new Button();
            cancel.Location = new Point(442, 244);
            cancel.Size = new Size(86, 30);
            cancel.Text = "Cancel";
            cancel.Click += delegate { Close(); };
            Controls.Add(cancel);
            CancelButton = cancel;

            FormClosing += FormIsClosing;
        }

        private void FormIsClosing(object sender, FormClosingEventArgs args)
        {
            if (installing)
            {
                args.Cancel = true;
            }
        }

        private async void PrimaryClick(object sender, EventArgs args)
        {
            if (installed)
            {
                if (launchGui.Checked)
                {
                    try
                    {
                        Process.Start(new ProcessStartInfo
                        {
                            FileName = InstalledGuiPath(options),
                            UseShellExecute = true,
                        });
                    }
                    catch (Exception error)
                    {
                        MessageBox.Show(
                            "Installation succeeded, but the app could not be opened.\r\n\r\n" + error.Message,
                            "Could not open app",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Warning);
                    }
                }
                Close();
                return;
            }

            options.NoDesktopShortcut = !desktopShortcut.Checked;
            installing = true;
            primary.Enabled = false;
            cancel.Enabled = false;
            desktopShortcut.Enabled = false;
            progress.Visible = true;
            detail.Text = "Installing the private per-user runtime and shortcuts...";

            try
            {
                InstallResult result = await Task.Run(delegate { return RunInstall(options); });
                if (result.ExitCode != 0)
                {
                    throw new InvalidOperationException(TrimDiagnostic(result.Output));
                }
                installed = true;
                ResultCode = 0;
                heading.Text = "Installation complete";
                detail.Text =
                    "Codex ChatGPT Web is ready. Use this app to finish ChatGPT setup and " +
                    "start or stop the foreground session.";
                desktopShortcut.Visible = false;
                launchGui.Visible = true;
                progress.Visible = false;
                primary.Text = "Finish";
                primary.Enabled = true;
                cancel.Visible = false;
                AcceptButton = primary;
            }
            catch (Exception error)
            {
                ResultCode = 1;
                detail.Text = "Installation did not complete. No automatic startup entry was created.";
                progress.Visible = false;
                primary.Text = "Retry";
                primary.Enabled = true;
                cancel.Enabled = true;
                desktopShortcut.Enabled = true;
                MessageBox.Show(
                    "Setup could not finish.\r\n\r\n" + error.Message,
                    "Installation failed",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
            finally
            {
                installing = false;
            }
        }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            InstallerOptions options = ParseOptions(args);
            if (options.Quiet)
            {
                InstallResult result = RunInstall(options);
                if (result.ExitCode != 0)
                {
                    WriteQuietError(result.Output);
                    return result.ExitCode;
                }
                if (!options.NoLaunch)
                {
                    LaunchInstalledGui(options);
                }
                return 0;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (SetupForm form = new SetupForm(options))
            {
                Application.Run(form);
                return form.ResultCode;
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "Setup could not start.\r\n\r\n" + error.Message,
                "Codex ChatGPT Web Setup",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }
    }

    private static InstallerOptions ParseOptions(string[] args)
    {
        InstallerOptions options = new InstallerOptions();
        for (int index = 0; index < args.Length; index++)
        {
            string argument = args[index];
            switch (argument)
            {
                case "--quiet":
                    options.Quiet = true;
                    break;
                case "--no-launch":
                    options.NoLaunch = true;
                    break;
                case "--no-path":
                    options.NoPath = true;
                    break;
                case "--no-desktop-shortcut":
                    options.NoDesktopShortcut = true;
                    break;
                case "--no-shortcuts":
                    options.NoShortcuts = true;
                    break;
                case "--no-register":
                    options.NoRegister = true;
                    break;
                case "--bin-dir":
                    options.BinDir = NextValue(args, ref index, argument);
                    break;
                case "--lib-dir":
                    options.LibDir = NextValue(args, ref index, argument);
                    break;
                case "--doc-dir":
                    options.DocDir = NextValue(args, ref index, argument);
                    break;
                case "--app-home":
                    options.AppHome = NextValue(args, ref index, argument);
                    break;
                default:
                    throw new ArgumentException("Unknown setup option: " + argument);
            }
        }
        return options;
    }

    private static string NextValue(string[] args, ref int index, string option)
    {
        index++;
        if (index >= args.Length || String.IsNullOrWhiteSpace(args[index]))
        {
            throw new ArgumentException(option + " requires a path");
        }
        return Path.GetFullPath(args[index]);
    }

    private static InstallResult RunInstall(InstallerOptions options)
    {
        string temporaryRoot = Path.Combine(
            Path.GetTempPath(),
            "codex-chatgpt-web-offline-setup-" + Guid.NewGuid().ToString("N"));
        InstallResult result = null;
        string cleanupError = null;
        try
        {
            Directory.CreateDirectory(temporaryRoot);
            string scriptsDirectory = Path.Combine(temporaryRoot, "scripts");
            string licensesDirectory = Path.Combine(temporaryRoot, "LICENSES");
            string docsDirectory = Path.Combine(temporaryRoot, "docs");
            string distDirectory = Path.Combine(temporaryRoot, "dist");
            string runtimeDirectory = Path.Combine(distDirectory, "runtime");
            Directory.CreateDirectory(scriptsDirectory);
            Directory.CreateDirectory(licensesDirectory);
            Directory.CreateDirectory(docsDirectory);
            Directory.CreateDirectory(distDirectory);

            string runtimeArchive = Path.Combine(distDirectory, "runtime.zip");
            string installScript = Path.Combine(scriptsDirectory, "install.ps1");
            ExtractResource(RuntimeResource, runtimeArchive);
            ExtractResource(InstallerResource, installScript);
            ExtractResource(LicenseResource, Path.Combine(temporaryRoot, "LICENSE"));
            ExtractResource(NoticeResource, Path.Combine(licensesDirectory, "NOTICE.md"));
            ExtractResource(OpenCodexLicenseResource, Path.Combine(licensesDirectory, "OpenCodex-MIT.txt"));
            ExtractResource(BunLicenseResource, Path.Combine(licensesDirectory, "Bun-1.3.11.md"));
            ExtractResource(ThirdPartyResource, Path.Combine(distDirectory, "THIRD_PARTY_NOTICES.txt"));
            ExtractResource(WindowsSetupResource, Path.Combine(docsDirectory, "windows.md"));
            ZipFile.ExtractToDirectory(runtimeArchive, runtimeDirectory);

            List<string> arguments = new List<string>();
            arguments.Add("-NoProfile");
            arguments.Add("-NonInteractive");
            arguments.Add("-ExecutionPolicy");
            arguments.Add("Bypass");
            arguments.Add("-File");
            arguments.Add(installScript);
            arguments.Add("-LocalBundle");
            arguments.Add(runtimeDirectory);
            AddPathOption(arguments, "-BinDir", options.BinDir);
            AddPathOption(arguments, "-LibDir", options.LibDir);
            AddPathOption(arguments, "-DocDir", options.DocDir);
            AddPathOption(arguments, "-AppHome", options.AppHome);
            if (options.NoPath)
            {
                arguments.Add("-NoPath");
            }
            if (options.NoDesktopShortcut)
            {
                arguments.Add("-NoDesktopShortcut");
            }
            if (options.NoShortcuts)
            {
                arguments.Add("-NoShortcuts");
            }
            if (options.NoRegister)
            {
                arguments.Add("-NoUninstallRegistration");
            }

            string systemDirectory = Environment.GetFolderPath(Environment.SpecialFolder.System);
            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = Path.Combine(systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
            startInfo.Arguments = JoinArguments(arguments);
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.WindowStyle = ProcessWindowStyle.Hidden;
            startInfo.RedirectStandardOutput = true;
            startInfo.RedirectStandardError = true;
            using (Process process = Process.Start(startInfo))
            {
                Task<string> standardOutput = process.StandardOutput.ReadToEndAsync();
                Task<string> standardError = process.StandardError.ReadToEndAsync();
                process.WaitForExit();
                Task.WaitAll(standardOutput, standardError);
                result = new InstallResult();
                result.ExitCode = process.ExitCode;
                result.Output = standardOutput.Result + standardError.Result;
            }
        }
        catch (Exception error)
        {
            result = new InstallResult();
            result.ExitCode = 1;
            result.Output = error.Message;
        }
        finally
        {
            cleanupError = DeleteTemporaryDirectory(temporaryRoot);
        }

        if (!String.IsNullOrEmpty(cleanupError))
        {
            result.ExitCode = 1;
            result.Output = result.Output + Environment.NewLine + cleanupError;
        }
        return result;
    }

    private static void AddPathOption(List<string> arguments, string option, string value)
    {
        if (!String.IsNullOrWhiteSpace(value))
        {
            arguments.Add(option);
            arguments.Add(value);
        }
    }

    private static void ExtractResource(string resourceName, string destination)
    {
        string parent = Path.GetDirectoryName(destination);
        if (!String.IsNullOrEmpty(parent))
        {
            Directory.CreateDirectory(parent);
        }
        using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName))
        {
            if (resource == null)
            {
                throw new InvalidDataException("Offline setup resource is missing: " + resourceName);
            }
            using (FileStream output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                resource.CopyTo(output);
            }
        }
    }

    private static string DeleteTemporaryDirectory(string path)
    {
        if (String.IsNullOrEmpty(path) || !Directory.Exists(path))
        {
            return null;
        }
        Exception lastError = null;
        for (int attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                Directory.Delete(path, true);
                return null;
            }
            catch (Exception error)
            {
                lastError = error;
                Thread.Sleep(100);
            }
        }
        return "Temporary setup files could not be removed: " + lastError.Message;
    }

    private static string InstalledGuiPath(InstallerOptions options)
    {
        string binDirectory = options.BinDir;
        if (String.IsNullOrWhiteSpace(binDirectory))
        {
            binDirectory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "codex-chatgpt-web",
                "bin");
        }
        return Path.Combine(binDirectory, "codex-chatgpt-web-gui.exe");
    }

    private static void LaunchInstalledGui(InstallerOptions options)
    {
        Process.Start(new ProcessStartInfo
        {
            FileName = InstalledGuiPath(options),
            UseShellExecute = true,
        });
    }

    private static string JoinArguments(List<string> arguments)
    {
        StringBuilder commandLine = new StringBuilder();
        for (int index = 0; index < arguments.Count; index++)
        {
            if (index > 0)
            {
                commandLine.Append(' ');
            }
            commandLine.Append(QuoteArgument(arguments[index]));
        }
        return commandLine.ToString();
    }

    private static string QuoteArgument(string argument)
    {
        if (argument.Length > 0 &&
            argument.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return argument;
        }

        StringBuilder quoted = new StringBuilder();
        quoted.Append('"');
        int backslashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1);
                quoted.Append('"');
                backslashes = 0;
                continue;
            }
            quoted.Append('\\', backslashes);
            backslashes = 0;
            quoted.Append(character);
        }
        quoted.Append('\\', backslashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static string TrimDiagnostic(string output)
    {
        string text = String.IsNullOrWhiteSpace(output) ? "The installer returned an error." : output.Trim();
        if (text.Length > 5000)
        {
            return text.Substring(text.Length - 5000);
        }
        return text;
    }

    private static void WriteQuietError(string output)
    {
        try
        {
            using (Stream stream = Console.OpenStandardError())
            using (StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false)))
            {
                writer.WriteLine(TrimDiagnostic(output));
            }
        }
        catch
        {
            // Quiet setup still returns a nonzero exit code if no stderr handle
            // is available (for example when launched directly from Explorer).
        }
    }
}
