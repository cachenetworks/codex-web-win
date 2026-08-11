using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class GuiProgram
{
    internal const string ProductName = "Codex ChatGPT Web";
    internal const string AppName = "codex-chatgpt-web-gui";
    internal const string Version = "0.2.8";
    internal const string WindowTitle = "Codex ChatGPT Web - Windows Control Center";

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--about-json")
        {
            WriteStandardOutput(AboutJson() + Environment.NewLine);
            return 0;
        }
        if (args.Length > 0 && args[0] == "--self-test")
        {
            bool ok;
            WriteStandardOutput(SelfTestJson(out ok) + Environment.NewLine);
            return ok ? 0 : 1;
        }
        if (args.Length > 0 && args[0] == "--lifecycle-smoke")
        {
            return LifecycleSmoke(args);
        }
        if (args.Length != 0)
        {
            WriteStandardError("Unknown GUI argument." + Environment.NewLine);
            return 2;
        }

        if (Environment.OSVersion.Platform != PlatformID.Win32NT)
        {
            MessageBox.Show("This control center requires Windows.", ProductName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        EnableHighDpi();
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);

        string mutexName = "Local\\CodexChatGptWeb.Gui." + CurrentUserKey();
        bool created;
        using (Mutex mutex = new Mutex(true, mutexName, out created))
        {
            if (!created)
            {
                IntPtr existing = FindWindow(null, WindowTitle);
                if (existing != IntPtr.Zero)
                {
                    ShowWindow(existing, 9);
                    SetForegroundWindow(existing);
                }
                else
                {
                    MessageBox.Show("The Codex ChatGPT Web control center is already open.", ProductName,
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                return 0;
            }

            Application.ThreadException += delegate(object sender, ThreadExceptionEventArgs eventArgs)
            {
                MessageBox.Show(eventArgs.Exception.Message, ProductName, MessageBoxButtons.OK, MessageBoxIcon.Error);
            };
            Application.Run(new MainWindow());
        }
        return 0;
    }

    private static void EnableHighDpi()
    {
        try
        {
            if (!SetProcessDpiAwarenessContext(new IntPtr(-4)))
            {
                SetProcessDPIAware();
            }
        }
        catch (EntryPointNotFoundException)
        {
            try { SetProcessDPIAware(); } catch { }
        }
    }

    internal static string ExecutablePath()
    {
        return Path.GetFullPath(System.Reflection.Assembly.GetExecutingAssembly().Location);
    }

    internal static string BinDirectory()
    {
        return Path.GetDirectoryName(ExecutablePath());
    }

    internal static string InstallRoot()
    {
        return Path.GetFullPath(Path.Combine(BinDirectory(), ".."));
    }

    internal static string CliPath()
    {
        return Path.Combine(BinDirectory(), "codex-chatgpt-web.exe");
    }

    internal static string AppHome()
    {
        string configured = Environment.GetEnvironmentVariable("CODEX_CHATGPT_WEB_HOME");
        if (!String.IsNullOrWhiteSpace(configured))
        {
            return Path.GetFullPath(configured.Trim());
        }
        string launcherConfiguration = Path.Combine(BinDirectory(), "codex-chatgpt-web.launcher");
        try
        {
            if (File.Exists(launcherConfiguration))
            {
                string[] lines = File.ReadAllLines(launcherConfiguration, Encoding.UTF8);
                if (lines.Length == 4 && lines[0] == "v1")
                {
                    return Path.GetFullPath(Encoding.UTF8.GetString(Convert.FromBase64String(lines[3])));
                }
            }
        }
        catch { }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex-chatgpt-web");
    }

    private static string Architecture()
    {
        string value = Environment.GetEnvironmentVariable("PROCESSOR_ARCHITEW6432");
        if (String.IsNullOrWhiteSpace(value))
        {
            value = Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE");
        }
        if (String.IsNullOrWhiteSpace(value)) return "unknown";
        value = value.ToLowerInvariant();
        if (value == "amd64" || value == "x86_64") return "x64";
        if (value == "aarch64") return "arm64";
        return value;
    }

    private static string AboutJson()
    {
        return "{" +
            "\"schemaVersion\":1," +
            "\"app\":\"" + AppName + "\"," +
            "\"version\":\"" + Version + "\"," +
            "\"platform\":\"win32\"," +
            "\"architecture\":" + JsonString(Architecture()) + "," +
            "\"portable\":false," +
            "\"automaticStartup\":false," +
            "\"root\":" + JsonString(InstallRoot()) + "," +
            "\"cliPath\":" + JsonString(CliPath()) +
            "}";
    }

    private sealed class Check
    {
        internal string Id;
        internal bool Ok;
        internal string Message;
    }

    private static string SelfTestJson(out bool ok)
    {
        List<Check> checks = new List<Check>();
        bool windows = Environment.OSVersion.Platform == PlatformID.Win32NT;
        checks.Add(new Check { Id = "platform", Ok = windows, Message = windows ? "Windows detected" : "Windows is required" });

        string cli = CliPath();
        bool cliExists = File.Exists(cli);
        checks.Add(new Check { Id = "bundle", Ok = cliExists, Message = cliExists ? "Sibling CLI found" : "Sibling CLI is missing" });

        bool cliTransportOk = false;
        if (cliExists)
        {
            try
            {
                using (NativeJob transportJob = new NativeJob())
                {
                    JobChild transport = transportJob.Start(
                        cli, new[] { "gui", "status" }, null, null);
                    if (!transport.Wait(15000))
                    {
                        transport.Terminate(124);
                        transport.Wait(3000);
                    }
                    cliTransportOk = transport.ExitCode == 0 &&
                        transport.Stdout.TrimStart().StartsWith("{", StringComparison.Ordinal) &&
                        transport.Stdout.IndexOf("\"schemaVersion\":1", StringComparison.Ordinal) >= 0;
                }
            }
            catch
            {
                cliTransportOk = false;
            }
        }
        checks.Add(new Check
        {
            Id = "cliTransport",
            Ok = cliTransportOk,
            Message = cliTransportOk
                ? "Sibling CLI output transport is working"
                : "Sibling CLI output transport failed"
        });

        string appHome = AppHome();
        string configPath = Path.Combine(appHome, "config.json");
        bool configOk = false;
        string chromePath = null;
        string configMessage;
        try
        {
            FileInfo configFile = new FileInfo(configPath);
            if (!configFile.Exists) throw new FileNotFoundException("Configuration is missing", configPath);
            if (configFile.Length <= 0 || configFile.Length > 128 * 1024)
            {
                throw new InvalidDataException("Configuration size is invalid");
            }
            Dictionary<string, object> config = ParseConfiguration(
                File.ReadAllText(configPath, Encoding.UTF8));
            configOk = ValidateConfiguration(config, out chromePath, out configMessage);
        }
        catch (Exception)
        {
            configMessage = "Configuration is missing, unreadable, or invalid";
        }
        checks.Add(new Check { Id = "config", Ok = configOk, Message = configMessage });

        bool chromeExists = configOk && File.Exists(chromePath);
        checks.Add(new Check
        {
            Id = "chrome",
            Ok = chromeExists,
            Message = chromeExists ? "Configured Chrome found" : "Configured Chrome is missing"
        });

        ok = true;
        foreach (Check check in checks) ok = ok && check.Ok;
        StringBuilder json = new StringBuilder();
        json.Append("{\"schemaVersion\":1,\"ok\":");
        json.Append(ok ? "true" : "false");
        json.Append(",\"root\":").Append(JsonString(InstallRoot()));
        json.Append(",\"cliPath\":").Append(JsonString(cli));
        json.Append(",\"appHome\":").Append(JsonString(appHome));
        json.Append(",\"checks\":[");
        for (int index = 0; index < checks.Count; index++)
        {
            if (index > 0) json.Append(',');
            json.Append("{\"id\":").Append(JsonString(checks[index].Id));
            json.Append(",\"ok\":").Append(checks[index].Ok ? "true" : "false");
            json.Append(",\"message\":").Append(JsonString(checks[index].Message)).Append('}');
        }
        json.Append("]}");
        return json.ToString();
    }

    private static int LifecycleSmoke(string[] args)
    {
        if (args.Length != 3)
        {
            WriteStandardError("Usage: --lifecycle-smoke CHILD_EXE PID_FILE" + Environment.NewLine);
            return 2;
        }
        string childExecutable = Path.GetFullPath(args[1]);
        string pidFile = Path.GetFullPath(args[2]);
        try
        {
            using (NativeJob job = new NativeJob())
            {
                JobChild child = job.Start(childExecutable, new[] { pidFile }, null, null);
                child.Wait(-1);
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            WriteStandardOutput("{\"schemaVersion\":1,\"ok\":false,\"error\":" +
                JsonString(error.Message) + "}" + Environment.NewLine);
            return 1;
        }
    }

    private static bool IsProcessAlive(int pid)
    {
        if (pid <= 0) return false;
        try
        {
            using (Process process = Process.GetProcessById(pid))
            {
                return !process.HasExited;
            }
        }
        catch { return false; }
    }

    internal static string JsonString(string value)
    {
        if (value == null) return "null";
        StringBuilder result = new StringBuilder();
        result.Append('"');
        foreach (char character in value)
        {
            switch (character)
            {
                case '"': result.Append("\\\""); break;
                case '\\': result.Append("\\\\"); break;
                case '\b': result.Append("\\b"); break;
                case '\f': result.Append("\\f"); break;
                case '\n': result.Append("\\n"); break;
                case '\r': result.Append("\\r"); break;
                case '\t': result.Append("\\t"); break;
                default:
                    if (character < 32)
                    {
                        result.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else result.Append(character);
                    break;
            }
        }
        return result.Append('"').ToString();
    }

    private static Dictionary<string, object> ParseConfiguration(string json)
    {
        JavaScriptSerializer serializer = new JavaScriptSerializer();
        serializer.MaxJsonLength = 128 * 1024;
        serializer.RecursionLimit = 32;
        Dictionary<string, object> parsed =
            serializer.DeserializeObject(json) as Dictionary<string, object>;
        if (parsed == null) throw new InvalidDataException("Configuration is not a JSON object");
        return parsed;
    }

    private static bool ValidateConfiguration(
        Dictionary<string, object> config,
        out string chromePath,
        out string message)
    {
        chromePath = null;
        message = "Configuration is missing required fields";
        object value;
        int version;
        int port;
        int contextWindow;
        string mode;
        string host;
        if (!config.TryGetValue("version", out value) ||
            !TryExactInteger(value, out version) ||
            version != 2 ||
            !TryRequiredString(config, "releaseVersion", out host) ||
            !TryRequiredString(config, "mode", out mode) ||
            (mode != "browser-only" && mode != "full") ||
            !TryRequiredString(config, "host", out host) ||
            host != "127.0.0.1" ||
            !config.TryGetValue("port", out value) ||
            !TryExactInteger(value, out port) ||
            port < 1 || port > 65535 ||
            !config.TryGetValue("contextWindow", out value) ||
            !TryExactInteger(value, out contextWindow) ||
            contextWindow < 1)
        {
            return false;
        }

        string ignored;
        string storageStatePath;
        string brokerSocketPath;
        string controlToken;
        if (!TryRequiredString(config, "appName", out ignored) ||
            !TryRequiredString(config, "chromeExecutablePath", out chromePath) ||
            !Path.IsPathRooted(chromePath) ||
            !TryRequiredString(config, "storageStatePath", out storageStatePath) ||
            !Path.IsPathRooted(storageStatePath) ||
            !TryRequiredString(config, "brokerSocketPath", out brokerSocketPath) ||
            (!brokerSocketPath.StartsWith("\\\\.\\pipe\\", StringComparison.OrdinalIgnoreCase) &&
             !Path.IsPathRooted(brokerSocketPath)) ||
            !TryRequiredString(config, "controlToken", out controlToken) ||
            !Regex.IsMatch(controlToken, "^[A-Za-z0-9_-]{40,}$", RegexOptions.CultureInvariant) ||
            !TryRequiredBoolean(config, "headed") ||
            !TryRequiredBoolean(config, "proAvailable") ||
            !TryRequiredBoolean(config, "autoApproveToolCalls") ||
            !config.TryGetValue("runtimeCommand", out value))
        {
            return false;
        }

        object[] command = value as object[];
        if (command == null || command.Length < 2) return false;
        foreach (object part in command)
        {
            if (String.IsNullOrWhiteSpace(part as string)) return false;
        }
        string runtimeExecutable = command[0] as string;
        string runtimeEntrypoint = command[command.Length - 1] as string;
        if (!Path.IsPathRooted(runtimeExecutable) || !File.Exists(runtimeExecutable) ||
            !Path.IsPathRooted(runtimeEntrypoint) || !File.Exists(runtimeEntrypoint))
        {
            return false;
        }
        if (mode == "full")
        {
            if (!config.TryGetValue("tunnel", out value)) return false;
            Dictionary<string, object> tunnel = value as Dictionary<string, object>;
            string binaryPath;
            string runtimeKeyFile;
            string profileDir;
            if (tunnel == null ||
                !TryRequiredString(tunnel, "binaryPath", out binaryPath) ||
                !Path.IsPathRooted(binaryPath) ||
                !TryRequiredString(tunnel, "tunnelId", out ignored) ||
                !TryRequiredString(tunnel, "runtimeKeyFile", out runtimeKeyFile) ||
                !Path.IsPathRooted(runtimeKeyFile) ||
                !TryRequiredString(tunnel, "profileDir", out profileDir) ||
                !Path.IsPathRooted(profileDir) ||
                !TryRequiredString(tunnel, "profileName", out ignored) ||
                !TryRequiredString(tunnel, "alias", out ignored))
            {
                return false;
            }
        }

        message = "Configuration parsed and validated";
        return true;
    }

    private static bool TryExactInteger(object value, out int result)
    {
        result = 0;
        if (value is int)
        {
            result = (int)value;
            return true;
        }
        if (value is long)
        {
            long number = (long)value;
            if (number < Int32.MinValue || number > Int32.MaxValue) return false;
            result = (int)number;
            return true;
        }
        if (value is decimal)
        {
            decimal number = (decimal)value;
            if (Decimal.Truncate(number) != number || number < Int32.MinValue || number > Int32.MaxValue)
                return false;
            result = Decimal.ToInt32(number);
            return true;
        }
        return false;
    }

    private static bool TryRequiredBoolean(Dictionary<string, object> values, string key)
    {
        object value;
        return values.TryGetValue(key, out value) && value is bool;
    }

    private static bool TryRequiredString(
        Dictionary<string, object> values,
        string key,
        out string result)
    {
        object raw;
        result = null;
        if (!values.TryGetValue(key, out raw)) return false;
        result = raw as string;
        return !String.IsNullOrWhiteSpace(result);
    }

    private static string CurrentUserKey()
    {
        try
        {
            return WindowsIdentity.GetCurrent().User.Value.Replace('-', '_');
        }
        catch
        {
            return Environment.UserName.GetHashCode().ToString("x", CultureInfo.InvariantCulture);
        }
    }

    private static void WriteStandardOutput(string value)
    {
        try
        {
            using (Stream stream = Console.OpenStandardOutput())
            using (StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false)))
            {
                writer.Write(value);
            }
        }
        catch { }
    }

    private static void WriteStandardError(string value)
    {
        try
        {
            using (Stream stream = Console.OpenStandardError())
            using (StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false)))
            {
                writer.Write(value);
            }
        }
        catch { }
    }
}

internal sealed class MainWindow : Form
{
    private const int MaxLiveLogCharacters = 250000;
    private const int RetainedLiveLogCharacters = 200000;
    private const int ReadinessPollIntervalMilliseconds = 750;
    private const int ReadinessPollWindowSeconds = 30;
    private readonly Color Navy = Color.FromArgb(21, 34, 56);
    private readonly Color Blue = Color.FromArgb(41, 112, 255);
    private readonly Color Pale = Color.FromArgb(245, 248, 252);
    private readonly NativeJob job;
    private readonly string cliPath;
    private TabControl tabs;
    private Label headerStatus;
    private Label runtimeModeStatus;
    private Label runtimeStatus;
    private Label setupStatus;
    private RichTextBox logBox;
    private RichTextBox diagnosticsBox;
    private Button startButton;
    private Button stopButton;
    private Button setupButton;
    private Button openCodexButton;
    private RadioButton browserOnly;
    private RadioButton fullMode;
    private TextBox tunnelId;
    private TextBox runtimeKey;
    private TextBox appName;
    private TextBox chromePath;
    private NumericUpDown port;
    private CheckBox acknowledgement;
    private CheckBox forceLogin;
    private CheckBox autoApprove;
    private CheckBox replaceRoute;
    private GroupBox fullOptions;
    private Label fullCredentialHint;
    private JobChild session;
    private JobChild activeOperation;
    private bool closing;
    private bool allowClose;
    private bool busy;
    private bool setupReady;
    private bool observedSessionRunning;
    private bool externalSessionRunning;
    private bool runtimeReady;
    private bool cliVersionMatches;
    private bool setupActionAllowed;
    private bool statusRefreshInFlight;
    private bool readinessPollingExpired;
    private bool setupFieldsHydrated;
    private bool existingTunnelIdConfigured;
    private bool existingRuntimeKeyConfigured;
    private bool codexRouteRepairRequired;
    private string configuredMode;
    private int activeHttpTurns;
    private int activeBrowserTurns;
    private readonly System.Windows.Forms.Timer readinessTimer;
    private DateTime readinessDeadlineUtc;
    private Icon applicationIcon;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr icon);

    internal MainWindow()
    {
        Text = GuiProgram.WindowTitle;
        Width = 1050;
        Height = 760;
        MinimumSize = new Size(880, 640);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Pale;
        Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
        AutoScaleMode = AutoScaleMode.Dpi;
        KeyPreview = true;
        cliPath = GuiProgram.CliPath();
        job = new NativeJob();
        readinessTimer = new System.Windows.Forms.Timer();
        readinessTimer.Interval = ReadinessPollIntervalMilliseconds;
        readinessTimer.Tick += delegate { PollReadiness(); };
        applicationIcon = CreateApplicationIcon();
        if (applicationIcon != null) Icon = applicationIcon;
        BuildInterface();
        Shown += delegate { RefreshStatus(); };
        FormClosing += OnFormClosing;
        FormClosed += delegate
        {
            readinessTimer.Stop();
            readinessTimer.Dispose();
            job.Dispose();
            if (applicationIcon != null)
            {
                applicationIcon.Dispose();
                applicationIcon = null;
            }
        };
    }

    private static Icon CreateApplicationIcon()
    {
        using (Bitmap bitmap = new Bitmap(32, 32))
        using (Graphics graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.Clear(Color.FromArgb(21, 34, 56));
            using (Pen outer = new Pen(Color.FromArgb(96, 165, 250), 3F))
            {
                graphics.DrawArc(outer, new Rectangle(4, 4, 23, 23), 30, 285);
            }
            using (Pen inner = new Pen(Color.White, 2F))
            {
                graphics.DrawArc(inner, new Rectangle(10, 10, 12, 12), 205, 285);
            }
            using (SolidBrush dot = new SolidBrush(Color.FromArgb(52, 211, 153)))
            {
                graphics.FillEllipse(dot, 22, 22, 7, 7);
            }
            IntPtr handle = bitmap.GetHicon();
            try
            {
                return (Icon)Icon.FromHandle(handle).Clone();
            }
            finally
            {
                DestroyIcon(handle);
            }
        }
    }

    private void BuildInterface()
    {
        Panel header = new Panel();
        header.Dock = DockStyle.Top;
        header.Height = 88;
        header.BackColor = Navy;

        BrandMark mark = new BrandMark();
        mark.Location = new Point(24, 18);
        mark.Size = new Size(52, 52);
        header.Controls.Add(mark);

        Label title = new Label();
        title.AutoSize = true;
        title.Text = "Codex + ChatGPT Web";
        title.ForeColor = Color.White;
        title.Font = new Font("Segoe UI Semibold", 18F, FontStyle.Bold);
        title.Location = new Point(88, 17);
        header.Controls.Add(title);

        Label subtitle = new Label();
        subtitle.AutoSize = true;
        subtitle.Text = "Windows control center - automatic startup is always Off";
        subtitle.ForeColor = Color.FromArgb(190, 205, 225);
        subtitle.Location = new Point(91, 53);
        header.Controls.Add(subtitle);

        headerStatus = new Label();
        headerStatus.Text = "Checking...";
        headerStatus.TextAlign = ContentAlignment.MiddleCenter;
        headerStatus.AutoSize = false;
        headerStatus.Size = new Size(150, 34);
        headerStatus.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        headerStatus.Location = new Point(ClientSize.Width - 178, 27);
        headerStatus.BackColor = Color.FromArgb(46, 61, 85);
        headerStatus.ForeColor = Color.White;
        header.Controls.Add(headerStatus);
        header.Resize += delegate { headerStatus.Left = header.ClientSize.Width - headerStatus.Width - 24; };

        tabs = new TabControl();
        tabs.Dock = DockStyle.Fill;
        tabs.Font = new Font("Segoe UI Semibold", 10F);
        tabs.Padding = new Point(18, 7);
        tabs.TabPages.Add(BuildHomeTab());
        tabs.TabPages.Add(BuildSetupTab());
        tabs.TabPages.Add(BuildDiagnosticsTab());
        tabs.TabPages.Add(BuildSupportTab());

        Controls.Add(tabs);
        Controls.Add(header);
    }

    private TabPage NewTab(string name)
    {
        TabPage page = new TabPage(name);
        page.BackColor = Pale;
        page.Padding = new Padding(22);
        return page;
    }

    private TabPage BuildHomeTab()
    {
        TabPage page = NewTab("Home");
        TableLayoutPanel layout = new TableLayoutPanel();
        layout.Dock = DockStyle.Fill;
        layout.ColumnCount = 1;
        layout.RowCount = 4;
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 72));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 112));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));

        Label welcome = new Label();
        welcome.Dock = DockStyle.Fill;
        welcome.Text = "Run ChatGPT Web models through your signed-in browser session.\r\n" +
            "Keep this window open while using Codex. X means stop everything and exit.";
        welcome.Font = new Font("Segoe UI", 11F);
        welcome.ForeColor = Navy;
        welcome.TextAlign = ContentAlignment.MiddleLeft;
        layout.Controls.Add(welcome, 0, 0);

        Panel statusCard = CardPanel();
        Label cardTitle = CardTitle("Foreground runtime");
        runtimeModeStatus = new Label();
        runtimeModeStatus.Text = "Mode not configured";
        runtimeModeStatus.Location = new Point(22, 43);
        runtimeModeStatus.AutoSize = true;
        runtimeModeStatus.Font = new Font("Segoe UI Semibold", 10F, FontStyle.Bold);
        runtimeModeStatus.ForeColor = Navy;
        runtimeStatus = new Label();
        runtimeStatus.Text = "Not checked";
        runtimeStatus.Location = new Point(22, 70);
        runtimeStatus.AutoSize = true;
        runtimeStatus.Font = new Font("Segoe UI", 9F);
        statusCard.Controls.Add(cardTitle);
        statusCard.Controls.Add(runtimeModeStatus);
        statusCard.Controls.Add(runtimeStatus);
        layout.Controls.Add(statusCard, 0, 1);

        FlowLayoutPanel actions = new FlowLayoutPanel();
        actions.Dock = DockStyle.Fill;
        actions.Padding = new Padding(0, 16, 0, 8);
        startButton = PrimaryButton("Start session");
        startButton.Enabled = false;
        startButton.Click += delegate { StartSession(); };
        stopButton = SecondaryButton("Stop everything");
        stopButton.Enabled = false;
        stopButton.Click += delegate { StopEverything(false, null); };
        Button refresh = SecondaryButton("Refresh status");
        refresh.Click += delegate { RefreshStatus(); };
        actions.Controls.Add(startButton);
        actions.Controls.Add(stopButton);
        actions.Controls.Add(refresh);
        layout.Controls.Add(actions, 0, 2);

        GroupBox activity = new GroupBox();
        activity.Text = "Live activity (secrets are never shown)";
        activity.Dock = DockStyle.Fill;
        logBox = new RichTextBox();
        logBox.Dock = DockStyle.Fill;
        logBox.ReadOnly = true;
        logBox.BackColor = Color.White;
        logBox.BorderStyle = BorderStyle.None;
        logBox.Font = new Font("Consolas", 9F);
        logBox.DetectUrls = false;
        activity.Controls.Add(logBox);
        layout.Controls.Add(activity, 0, 3);

        page.Controls.Add(layout);
        return page;
    }

    private TabPage BuildSetupTab()
    {
        TabPage page = NewTab("Setup");
        Panel scroll = new Panel();
        scroll.Dock = DockStyle.Fill;
        scroll.AutoScroll = true;

        Label heading = new Label();
        heading.Text = "First-time setup";
        heading.Font = new Font("Segoe UI Semibold", 18F, FontStyle.Bold);
        heading.ForeColor = Navy;
        heading.AutoSize = true;
        heading.Location = new Point(4, 4);
        scroll.Controls.Add(heading);

        GroupBox mode = new GroupBox();
        mode.Text = "1. Choose a mode";
        mode.Location = new Point(4, 48);
        mode.Size = new Size(940, 112);
        mode.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        browserOnly = new RadioButton();
        browserOnly.Text = "Browser-only (Recommended) - simplest setup, no tunnel or local tools";
        browserOnly.Checked = true;
        browserOnly.AutoSize = true;
        browserOnly.Location = new Point(20, 30);
        fullMode = new RadioButton();
        fullMode.Text = "Full mode (Advanced) - adds local tools through an OpenAI tunnel";
        fullMode.AutoSize = true;
        fullMode.Location = new Point(20, 66);
        fullMode.CheckedChanged += delegate { fullOptions.Enabled = fullMode.Checked; };
        mode.Controls.Add(browserOnly);
        mode.Controls.Add(fullMode);
        scroll.Controls.Add(mode);

        fullOptions = new GroupBox();
        fullOptions.Text = "2. Advanced full-mode credentials";
        fullOptions.Location = new Point(4, 172);
        fullOptions.Size = new Size(940, 116);
        fullOptions.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        fullOptions.Enabled = false;
        Label tunnelLabel = FieldLabel("Tunnel ID", 20, 30);
        tunnelId = FieldBox(150, 26, 310, false);
        Label keyLabel = FieldLabel("Runtime key", 490, 30);
        runtimeKey = FieldBox(600, 26, 300, true);
        fullCredentialHint = new Label();
        fullCredentialHint.Text = "The runtime key is sent once through redirected stdin. It never appears in arguments or logs.";
        fullCredentialHint.Location = new Point(20, 70);
        fullCredentialHint.AutoSize = true;
        fullCredentialHint.ForeColor = Color.FromArgb(90, 100, 115);
        fullOptions.Controls.Add(tunnelLabel);
        fullOptions.Controls.Add(tunnelId);
        fullOptions.Controls.Add(keyLabel);
        fullOptions.Controls.Add(runtimeKey);
        fullOptions.Controls.Add(fullCredentialHint);
        scroll.Controls.Add(fullOptions);

        GroupBox options = new GroupBox();
        options.Text = "3. Connection details";
        options.Location = new Point(4, 300);
        options.Size = new Size(940, 150);
        options.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        options.Controls.Add(FieldLabel("Connector name", 20, 31));
        appName = FieldBox(150, 27, 250, false);
        appName.Text = "Codex Native";
        options.Controls.Add(appName);
        options.Controls.Add(FieldLabel("Port", 430, 31));
        port = new NumericUpDown();
        port.Location = new Point(485, 27);
        port.Width = 100;
        port.Minimum = 1;
        port.Maximum = 65535;
        port.Value = 17841;
        options.Controls.Add(port);
        options.Controls.Add(FieldLabel("Chrome", 20, 72));
        chromePath = FieldBox(150, 68, 610, false);
        options.Controls.Add(chromePath);
        Button browse = SecondaryButton("Browse...");
        browse.Location = new Point(775, 65);
        browse.Click += delegate { BrowseChrome(); };
        options.Controls.Add(browse);
        forceLogin = new CheckBox();
        forceLogin.Text = "Refresh login during setup";
        forceLogin.AutoSize = true;
        forceLogin.Location = new Point(150, 108);
        autoApprove = new CheckBox();
        autoApprove.Text = "Automatically click per-call Allow once prompts";
        autoApprove.AutoSize = true;
        autoApprove.Location = new Point(350, 108);
        replaceRoute = new CheckBox();
        replaceRoute.Text = "Replace an existing Codex route reversibly";
        replaceRoute.AutoSize = true;
        replaceRoute.Location = new Point(680, 108);
        options.Controls.Add(forceLogin);
        options.Controls.Add(autoApprove);
        options.Controls.Add(replaceRoute);
        scroll.Controls.Add(options);

        acknowledgement = new CheckBox();
        acknowledgement.Text = "I understand this is independent, unofficial browser automation that can break when ChatGPT changes.";
        acknowledgement.AutoSize = true;
        acknowledgement.Location = new Point(12, 466);
        scroll.Controls.Add(acknowledgement);

        Label loginInstruction = new Label();
        loginInstruction.Text = "When setup opens Chrome: sign in to ChatGPT, confirm the composer is visible, then close that Chrome window completely.";
        loginInstruction.Location = new Point(12, 500);
        loginInstruction.Size = new Size(900, 38);
        loginInstruction.ForeColor = Color.FromArgb(125, 74, 0);
        scroll.Controls.Add(loginInstruction);

        setupButton = PrimaryButton("Set up and sign in");
        setupButton.Location = new Point(12, 548);
        setupButton.Enabled = false;
        setupButton.Click += delegate { RunSetup(); };
        scroll.Controls.Add(setupButton);
        setupStatus = new Label();
        setupStatus.Text = "Ready";
        setupStatus.AutoSize = true;
        setupStatus.Location = new Point(210, 558);
        scroll.Controls.Add(setupStatus);

        Label fullGuide = new Label();
        fullGuide.Text = "Full mode final checklist (after setup):\r\n" +
            "1. Start runtime  2. Open ChatGPT Connectors  3. Attach and scan the chosen connector  4. Restart Codex\r\n" +
            "The tunnel cannot be verified until the foreground session is running.";
        fullGuide.Location = new Point(12, 604);
        fullGuide.Size = new Size(910, 64);
        fullGuide.ForeColor = Navy;
        scroll.Controls.Add(fullGuide);

        page.Controls.Add(scroll);
        return page;
    }

    private TabPage BuildDiagnosticsTab()
    {
        TabPage page = NewTab("Diagnostics");
        FlowLayoutPanel toolbar = new FlowLayoutPanel();
        toolbar.Dock = DockStyle.Top;
        toolbar.Height = 54;
        Button run = PrimaryButton("Run diagnostics");
        run.Click += delegate { RunDiagnostics(); };
        Button copy = SecondaryButton("Copy JSON");
        copy.Click += delegate
        {
            if (!String.IsNullOrWhiteSpace(diagnosticsBox.Text)) Clipboard.SetText(diagnosticsBox.Text);
        };
        toolbar.Controls.Add(run);
        toolbar.Controls.Add(copy);
        diagnosticsBox = new RichTextBox();
        diagnosticsBox.Dock = DockStyle.Fill;
        diagnosticsBox.ReadOnly = true;
        diagnosticsBox.BackColor = Color.White;
        diagnosticsBox.Font = new Font("Consolas", 9F);
        diagnosticsBox.Text = "Run diagnostics to view the complete doctor JSON report.";
        page.Controls.Add(diagnosticsBox);
        page.Controls.Add(toolbar);
        return page;
    }

    private TabPage BuildSupportTab()
    {
        TabPage page = NewTab("Settings & Support");
        FlowLayoutPanel flow = new FlowLayoutPanel();
        flow.Dock = DockStyle.Fill;
        flow.FlowDirection = FlowDirection.TopDown;
        flow.WrapContents = false;
        flow.AutoScroll = true;

        Label startup = new Label();
        startup.Text = "Automatic startup: Off\r\nThis app never creates an autorun entry. Closing it stops its session and exits.";
        startup.Font = new Font("Segoe UI Semibold", 11F);
        startup.ForeColor = Navy;
        startup.Size = new Size(850, 58);
        flow.Controls.Add(startup);

        FlowLayoutPanel links = new FlowLayoutPanel();
        links.AutoSize = true;
        openCodexButton = SecondaryButton("Open Codex app");
        openCodexButton.Enabled = false;
        openCodexButton.Click += delegate { OpenCodex(); };
        links.Controls.Add(openCodexButton);
        links.Controls.Add(LinkButton("ChatGPT Connectors", "https://chatgpt.com/#settings/Connectors"));
        links.Controls.Add(LinkButton("Tunnel settings", "https://platform.openai.com/settings/organization/tunnels"));
        links.Controls.Add(LinkButton("Runtime keys", "https://platform.openai.com/settings/organization/api-keys"));
        flow.Controls.Add(links);

        FlowLayoutPanel account = new FlowLayoutPanel();
        account.AutoSize = true;
        Button login = SecondaryButton("Refresh ChatGPT login");
        login.Click += delegate { RefreshLogin(); };
        Button guide = SecondaryButton("Open Windows setup guide");
        guide.Click += delegate { OpenGuide(); };
        account.Controls.Add(login);
        account.Controls.Add(guide);
        flow.Controls.Add(account);

        Label about = new Label();
        about.Text = ProductAboutText();
        about.Size = new Size(850, 80);
        about.Margin = new Padding(3, 24, 3, 3);
        flow.Controls.Add(about);

        Button uninstall = new Button();
        uninstall.Text = "Uninstall Codex ChatGPT Web...";
        uninstall.AutoSize = true;
        uninstall.FlatStyle = FlatStyle.Flat;
        uninstall.ForeColor = Color.FromArgb(180, 45, 45);
        uninstall.Click += delegate { BeginUninstall(); };
        flow.Controls.Add(uninstall);

        Button exit = SecondaryButton("Stop everything and exit");
        exit.Margin = new Padding(3, 22, 3, 3);
        exit.Click += delegate { Close(); };
        flow.Controls.Add(exit);
        page.Controls.Add(flow);
        return page;
    }

    private string ProductAboutText()
    {
        return GuiProgram.ProductName + " " + GuiProgram.Version + "\r\n" +
            "Install root: " + GuiProgram.InstallRoot() + "\r\n" +
            "Private state: " + GuiProgram.AppHome();
    }

    private Panel CardPanel()
    {
        Panel panel = new Panel();
        panel.Dock = DockStyle.Fill;
        panel.BackColor = Color.White;
        panel.Margin = new Padding(0, 4, 0, 4);
        panel.Paint += delegate(object sender, PaintEventArgs eventArgs)
        {
            using (Pen pen = new Pen(Color.FromArgb(220, 226, 235)))
            {
                eventArgs.Graphics.DrawRectangle(pen, 0, 0, panel.Width - 1, panel.Height - 1);
            }
        };
        return panel;
    }

    private Label CardTitle(string text)
    {
        Label label = new Label();
        label.Text = text;
        label.Font = new Font("Segoe UI Semibold", 12F, FontStyle.Bold);
        label.ForeColor = Navy;
        label.AutoSize = true;
        label.Location = new Point(20, 16);
        return label;
    }

    private Label FieldLabel(string text, int left, int top)
    {
        Label label = new Label();
        label.Text = text;
        label.AutoSize = true;
        label.Location = new Point(left, top + 4);
        return label;
    }

    private TextBox FieldBox(int left, int top, int width, bool password)
    {
        TextBox box = new TextBox();
        box.Location = new Point(left, top);
        box.Width = width;
        box.UseSystemPasswordChar = password;
        return box;
    }

    private Button PrimaryButton(string text)
    {
        Button button = new Button();
        button.Text = text;
        button.AutoSize = true;
        button.MinimumSize = new Size(145, 38);
        button.BackColor = Blue;
        button.ForeColor = Color.White;
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 0;
        button.Cursor = Cursors.Hand;
        return button;
    }

    private Button SecondaryButton(string text)
    {
        Button button = new Button();
        button.Text = text;
        button.AutoSize = true;
        button.MinimumSize = new Size(130, 38);
        button.BackColor = Color.White;
        button.ForeColor = Navy;
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderColor = Color.FromArgb(185, 196, 212);
        button.Cursor = Cursors.Hand;
        return button;
    }

    private Button LinkButton(string text, string url)
    {
        Button button = SecondaryButton(text);
        button.Click += delegate { OpenTarget(url); };
        return button;
    }

    private void BrowseChrome()
    {
        using (OpenFileDialog dialog = new OpenFileDialog())
        {
            dialog.Filter = "Google Chrome (chrome.exe)|chrome.exe|Programs (*.exe)|*.exe";
            dialog.Title = "Select Google Chrome";
            if (dialog.ShowDialog(this) == DialogResult.OK) chromePath.Text = dialog.FileName;
        }
    }

    private void ObserveSetupStatus(GuiStatusSnapshot status)
    {
        configuredMode = status.Mode;
        existingTunnelIdConfigured = status.TunnelIdConfigured;
        existingRuntimeKeyConfigured = status.RuntimeKeyConfigured;
        codexRouteRepairRequired = status.CodexRouteRepairRequired;

        if (!setupFieldsHydrated && !String.IsNullOrWhiteSpace(status.Mode))
        {
            fullMode.Checked = status.Mode == "full";
            browserOnly.Checked = status.Mode == "browser-only";
            if (status.SetupPort >= (int)port.Minimum && status.SetupPort <= (int)port.Maximum)
            {
                port.Value = status.SetupPort;
            }
            if (!String.IsNullOrWhiteSpace(status.SetupAppName)) appName.Text = status.SetupAppName;
            if (!String.IsNullOrWhiteSpace(status.ChromePath)) chromePath.Text = status.ChromePath;
            autoApprove.Checked = status.SetupAutoApprove;
            replaceRoute.Checked = status.CodexRouteRepairRequired;
            setupFieldsHydrated = true;
        }

        replaceRoute.Text = status.CodexRouteRepairRequired
            ? "Repair the changed Codex route reversibly (required)"
            : "Replace an existing Codex route reversibly";

        if (existingTunnelIdConfigured && existingRuntimeKeyConfigured)
        {
            fullCredentialHint.Text = "Saved full-mode credentials are configured. Leave both fields blank to reuse them securely.";
        }
        else if (existingTunnelIdConfigured)
        {
            fullCredentialHint.Text = "A saved tunnel ID is configured. Leave it blank to reuse it; enter a runtime key.";
        }
        else if (existingRuntimeKeyConfigured)
        {
            fullCredentialHint.Text = "A saved runtime key is configured. Leave it blank to reuse it; enter a tunnel ID.";
        }
        else
        {
            fullCredentialHint.Text = "The runtime key is sent once through redirected stdin. It never appears in arguments or logs.";
        }
    }

    private void RefreshStatus()
    {
        if (closing || statusRefreshInFlight) return;
        if (!File.Exists(cliPath))
        {
            cliVersionMatches = false;
            setupActionAllowed = false;
            setupReady = false;
            observedSessionRunning = false;
            externalSessionRunning = false;
            runtimeReady = false;
            SetStatus("CLI missing", "The sibling launcher was not found: " + cliPath, false);
            return;
        }
        statusRefreshInFlight = true;
        headerStatus.Text = "Checking...";
        StartCommand(new[] { "gui", "status" }, null, false, delegate(CommandResult result)
        {
            statusRefreshInFlight = false;
            GuiStatusSnapshot status;
            if (!TryParseGuiStatus(result, out status))
            {
                cliVersionMatches = false;
                setupActionAllowed = false;
                setupReady = false;
                observedSessionRunning = session != null && session.IsRunning;
                externalSessionRunning = false;
                runtimeReady = false;
                activeHttpTurns = 0;
                activeBrowserTurns = 0;
                SetStatus("Status error", "The CLI status response was unavailable or invalid.", false);
                return;
            }

            ObserveSetupStatus(status);

            bool ownedRunning = session != null && session.IsRunning;
            cliVersionMatches = String.Equals(
                status.Version, GuiProgram.Version, StringComparison.Ordinal);
            bool repairableConfiguration = status.ConfigurationRecoverable &&
                !String.IsNullOrWhiteSpace(status.ConfigError);
            setupActionAllowed = cliVersionMatches &&
                (String.IsNullOrWhiteSpace(status.ConfigError) || repairableConfiguration);
            setupButton.Text = cliVersionMatches && repairableConfiguration
                ? "Repair setup"
                : "Set up and sign in";
            setupReady = cliVersionMatches && status.Configured && status.ConfigurationCurrent &&
                status.ChromeFound && status.LoginReady;
            observedSessionRunning = status.Running || ownedRunning;
            externalSessionRunning = status.Running && !ownedRunning;
            runtimeReady = cliVersionMatches && status.Running && status.Healthy && status.AcceptingTurns;
            activeHttpTurns = status.ActiveHttpTurns;
            activeBrowserTurns = status.ActiveBrowserTurns;

            if (!cliVersionMatches)
            {
                StopReadinessPolling(false);
                setupStatus.Text = "Close this app and reinstall so the GUI and CLI versions match.";
                SetStatus("Installation mismatch",
                    "Control center " + GuiProgram.Version + " found sibling CLI " + status.Version +
                    ". Close this app and run the latest installer again.", false);
                tabs.SelectedIndex = 1;
            }
            else if (repairableConfiguration)
            {
                StopReadinessPolling(false);
                setupStatus.Text = "Review the options, then click Repair setup.";
                SetStatus("Repair setup",
                    "The saved setup references an unavailable or outdated runtime. " +
                    "Review Setup and click Repair setup to migrate it safely.", false);
                tabs.SelectedIndex = 1;
            }
            else if (!String.IsNullOrWhiteSpace(status.ConfigError))
            {
                StopReadinessPolling(false);
                setupStatus.Text = "The saved setup is invalid. Review Diagnostics before resetting it.";
                SetStatus("Configuration invalid",
                    "The saved setup cannot be migrated safely. Review Diagnostics, then reset or remove the invalid configuration.",
                    false);
                tabs.SelectedIndex = 2;
            }
            else if (!status.Configured)
            {
                setupStatus.Text = "Ready";
                SetStatus("Setup needed", "Choose Setup to connect Chrome and install the Codex route.", false);
                tabs.SelectedIndex = 1;
            }
            else if (!status.ConfigurationCurrent)
            {
                setupStatus.Text = "Run setup to update the saved configuration.";
                SetStatus("Update setup", "The saved setup belongs to another release. Run Setup again.", false);
                tabs.SelectedIndex = 1;
            }
            else if (!status.ChromeFound)
            {
                SetStatus("Chrome missing", "The configured Chrome executable was not found. Run Setup again.", false);
            }
            else if (!status.LoginReady)
            {
                SetStatus("Login needed", "Refresh the stored ChatGPT login before starting the runtime.", false);
            }
            else if (status.Running)
            {
                if (runtimeReady)
                {
                    StopReadinessPolling(false);
                    string owner = externalSessionRunning
                        ? "A ready foreground session started outside this window is running."
                        : "Foreground session is ready and owned by this window.";
                    SetStatus("Running", owner, true);
                }
                else if (readinessPollingExpired)
                {
                    SetStatus("Needs attention",
                        "The session did not become ready within 30 seconds. Review Live activity and diagnostics.",
                        false);
                }
                else
                {
                    BeginReadinessPolling();
                    string detail = status.Healthy
                        ? "The Responses proxy is listening. Waiting for the full-mode tunnel to accept turns."
                        : "Waiting for the foreground session health check.";
                    if (!status.Healthy && !String.IsNullOrWhiteSpace(status.Detail))
                    {
                        detail += " " + Sanitize(status.Detail);
                    }
                    SetStatus("Starting", detail, false);
                }
            }
            else if (ownedRunning)
            {
                if (!readinessPollingExpired) BeginReadinessPolling();
                SetStatus(readinessPollingExpired ? "Needs attention" : "Starting",
                    readinessPollingExpired
                        ? "The session did not become ready within 30 seconds. Review Live activity and diagnostics."
                        : "Waiting for the foreground session health check.",
                    false);
            }
            else
            {
                StopReadinessPolling(false);
                readinessPollingExpired = false;
                string detail = status.CodexInstalled
                    ? "Configured. Start the foreground runtime before opening Codex."
                    : "Runtime setup is ready. The Codex route is not currently installed.";
                SetStatus("Ready", detail, status.CodexInstalled);
            }
        }, false);
    }

    private void SetStatus(string shortStatus, string detail, bool good)
    {
        headerStatus.Text = shortStatus;
        headerStatus.BackColor = good ? Color.FromArgb(29, 122, 88) : Color.FromArgb(155, 91, 24);
        if (configuredMode == "full")
        {
            runtimeModeStatus.Text = "Full mode - local tools enabled";
            runtimeModeStatus.ForeColor = Color.FromArgb(29, 122, 88);
        }
        else if (configuredMode == "browser-only")
        {
            runtimeModeStatus.Text = "Browser-only mode - no local computer access";
            runtimeModeStatus.ForeColor = Color.FromArgb(155, 91, 24);
        }
        else
        {
            runtimeModeStatus.Text = "Mode not configured";
            runtimeModeStatus.ForeColor = Navy;
        }
        runtimeStatus.Text = detail;
        setupButton.Enabled = setupActionAllowed && !busy && !closing;
        openCodexButton.Enabled = runtimeReady && !busy && !closing;
        startButton.Enabled = setupReady && !busy && !observedSessionRunning &&
            (session == null || !session.IsRunning);
        stopButton.Enabled = !closing &&
            (busy || observedSessionRunning || activeOperation != null ||
             (session != null && session.IsRunning));
    }

    private void StartSession()
    {
        if (!cliVersionMatches)
        {
            ShowError("The control center and sibling CLI versions do not match. Close this app and run the latest installer again.");
            return;
        }
        if (!setupReady || observedSessionRunning || (session != null && session.IsRunning)) return;
        if (!File.Exists(cliPath))
        {
            ShowError("The sibling CLI is missing: " + cliPath);
            return;
        }
        AppendLog("Starting foreground session...");
        try
        {
            session = job.Start(cliPath, new[] { "session" }, null, OnChildLine);
            observedSessionRunning = true;
            session.Completed += delegate(JobChild child)
            {
                SafeUi(delegate
                {
                    AppendLog("Session exited with code " + child.ExitCode.ToString(CultureInfo.InvariantCulture) + ".");
                    if (Object.ReferenceEquals(session, child)) session = null;
                    RefreshStatus();
                });
            };
            runtimeReady = false;
            readinessPollingExpired = false;
            BeginReadinessPolling();
            SetStatus("Starting", "Waiting for the Responses proxy and optional tunnel.", false);
            RefreshStatus();
        }
        catch (Exception error)
        {
            session = null;
            ShowError(error.Message);
        }
    }

    private void RunSetup()
    {
        if (!setupActionAllowed)
        {
            ShowError(cliVersionMatches
                ? "Setup is disabled because the saved configuration is invalid. Review Diagnostics before resetting it."
                : "Setup is disabled because the control center and sibling CLI versions do not match. Close this app and run the latest installer again.");
            return;
        }
        if (busy)
        {
            ShowError("Another setup or diagnostic operation is still running.");
            return;
        }
        bool requestedFullMode = fullMode.Checked;
        if (!acknowledgement.Checked)
        {
            ShowError("Please acknowledge the unofficial-software notice before setup.");
            acknowledgement.Focus();
            return;
        }
        if (requestedFullMode && String.IsNullOrWhiteSpace(tunnelId.Text) && !existingTunnelIdConfigured)
        {
            ShowError("Full mode requires a tunnel ID. Enter one, or repair a setup that already has one configured.");
            tunnelId.Focus();
            return;
        }
        if (requestedFullMode && String.IsNullOrWhiteSpace(runtimeKey.Text) && !existingRuntimeKeyConfigured)
        {
            ShowError("Full mode requires a runtime key. Enter one, or repair a setup that already has one configured.");
            runtimeKey.Focus();
            return;
        }
        if (session != null && session.IsRunning)
        {
            ShowError("Stop the foreground session before changing setup.");
            return;
        }
        if (codexRouteRepairRequired && !replaceRoute.Checked)
        {
            ShowError("The managed Codex route changed after setup. Keep the route-repair option selected so setup can repair it reversibly.");
            replaceRoute.Focus();
            return;
        }
        if (configuredMode == "full" && !requestedFullMode)
        {
            DialogResult downgrade = MessageBox.Show(
                this,
                "Switching to Browser-only mode will disable local file, command, process, and MCP access. Continue?",
                GuiProgram.ProductName,
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning,
                MessageBoxDefaultButton.Button2);
            if (downgrade != DialogResult.Yes) return;
        }

        string secret = runtimeKey.Text;
        StringBuilder payload = new StringBuilder();
        payload.Append('{');
        AppendJsonPair(payload, "mode", requestedFullMode ? "full" : "browser-only", true);
        AppendJsonBoolean(payload, "acknowledgedUnofficial", true);
        AppendJsonBoolean(payload, "forceLogin", forceLogin.Checked);
        AppendJsonBoolean(payload, "autoApproveToolCalls", autoApprove.Checked);
        AppendJsonBoolean(payload, "replaceCodexRoute", replaceRoute.Checked);
        payload.Append(",\"port\":").Append(((int)port.Value).ToString(CultureInfo.InvariantCulture));
        if (!String.IsNullOrWhiteSpace(chromePath.Text)) AppendJsonPair(payload, "chromeExecutablePath", chromePath.Text.Trim(), false);
        AppendJsonPair(payload, "appName", String.IsNullOrWhiteSpace(appName.Text) ? "Codex Native" : appName.Text.Trim(), false);
        if (requestedFullMode)
        {
            if (!String.IsNullOrWhiteSpace(tunnelId.Text))
            {
                AppendJsonPair(payload, "tunnelId", tunnelId.Text.Trim(), false);
            }
            if (!String.IsNullOrWhiteSpace(secret))
            {
                AppendJsonPair(payload, "runtimeKeyValue", secret, false);
            }
        }
        payload.Append('}');
        string input = payload.ToString() + Environment.NewLine;
        setupStatus.Text = "Chrome will open; finish sign-in and close it.";
        SetBusy(true);
        try
        {
            JobChild child = job.Start(cliPath, new[] { "gui", "setup" }, input, OnChildLine);
            activeOperation = child;
            runtimeKey.Clear();
            secret = null;
            input = null;
            payload.Length = 0;
            child.Completed += delegate(JobChild completed)
            {
                SafeUi(delegate
                {
                    if (Object.ReferenceEquals(activeOperation, completed)) activeOperation = null;
                    SetBusy(false);
                    if (completed.ExitCode == 0)
                    {
                        setupStatus.Text = requestedFullMode
                            ? "Setup saved. Start runtime, attach/scan the connector, then restart Codex."
                            : "Setup complete. Start the runtime, then restart Codex.";
                        AppendLog("Setup completed successfully.");
                        tabs.SelectedIndex = 0;
                        RefreshStatus();
                    }
                    else
                    {
                        setupStatus.Text = "Setup failed. Review Live activity.";
                        ShowError(SafeFailure(completed));
                    }
                });
            };
        }
        catch (Exception error)
        {
            runtimeKey.Clear();
            secret = null;
            input = null;
            payload.Length = 0;
            SetBusy(false);
            ShowError(error.Message);
        }
    }

    private static void AppendJsonPair(StringBuilder json, string key, string value, bool first)
    {
        if (!first) json.Append(',');
        json.Append(GuiProgram.JsonString(key)).Append(':').Append(GuiProgram.JsonString(value));
    }

    private static void AppendJsonBoolean(StringBuilder json, string key, bool value)
    {
        json.Append(',').Append(GuiProgram.JsonString(key)).Append(':').Append(value ? "true" : "false");
    }

    private void RunDiagnostics()
    {
        if (busy) return;
        SetBusy(true);
        diagnosticsBox.Text = "Running diagnostics...";
        StartCommand(new[] { "doctor", "--json" }, null, false, delegate(CommandResult result)
        {
            diagnosticsBox.Text = String.IsNullOrWhiteSpace(result.Stdout) ? result.Stderr : result.Stdout;
            SetBusy(false);
        }, false);
    }

    private void RefreshLogin()
    {
        if (busy) return;
        if (session != null && session.IsRunning)
        {
            MessageBox.Show("Stop the foreground session before refreshing the stored login.", GuiProgram.ProductName,
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        DialogResult answer = MessageBox.Show(
            "A dedicated Chrome window will open. Sign in, confirm the composer is visible, then close Chrome completely.",
            "Refresh ChatGPT login", MessageBoxButtons.OKCancel, MessageBoxIcon.Information);
        if (answer != DialogResult.OK) return;
        SetBusy(true);
        StartCommand(new[] { "login" }, null, true, delegate(CommandResult result)
        {
            SetBusy(false);
            if (result.ExitCode == 0)
            {
                AppendLog("ChatGPT login refreshed.");
                RefreshStatus();
            }
            else ShowError(SafeFailure(result));
        }, true);
    }

    private void StartCommand(string[] arguments, string input, bool logOutput,
        Action<CommandResult> completed, bool markActive)
    {
        try
        {
            Action<string, bool> outputHandler = logOutput ? new Action<string, bool>(OnChildLine) : null;
            JobChild child = job.Start(cliPath, arguments, input, outputHandler);
            if (markActive) activeOperation = child;
            child.Completed += delegate(JobChild finished)
            {
                SafeUi(delegate
                {
                    if (Object.ReferenceEquals(activeOperation, finished)) activeOperation = null;
                    completed(new CommandResult(finished.ExitCode, finished.Stdout, finished.Stderr));
                });
            };
        }
        catch (Exception error)
        {
            completed(new CommandResult(1, "", error.Message));
        }
    }

    private void StopEverything(bool exitAfter, Action afterStop)
    {
        if (closing && !exitAfter) return;
        bool mayCancelTask = activeHttpTurns > 0 || activeBrowserTurns > 0 || activeOperation != null;
        if (mayCancelTask)
        {
            DialogResult answer = MessageBox.Show(
                "Stopping now may cancel the current Codex task or sign-in operation. Continue?",
                "Stop everything", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (answer != DialogResult.Yes)
            {
                if (exitAfter) closing = false;
                return;
            }
        }
        if (exitAfter) closing = true;
        SetBusy(true);
        AppendLog("Requesting graceful session shutdown...");
        ThreadPool.QueueUserWorkItem(delegate
        {
            JobChild ownedSession = session;
            job.TerminateExcept(ownedSession, 1223);
            CommandResult stopResult;
            try
            {
                JobChild stopper = job.Start(cliPath, new[] { "gui", "stop-session" }, null, null);
                if (!stopper.Wait(10000))
                {
                    stopper.Terminate(124);
                    if (!stopper.Wait(3000))
                    {
                        job.TerminateExcept(ownedSession, 124);
                        stopper.Wait(3000);
                    }
                }
                stopResult = new CommandResult(stopper.ExitCode, stopper.Stdout, stopper.Stderr);
            }
            catch (Exception error)
            {
                stopResult = new CommandResult(1, "", error.Message);
            }
            if (ownedSession != null && !ownedSession.Wait(8000))
            {
                ownedSession.Terminate(1);
                ownedSession.Wait(3000);
            }
            if (exitAfter) job.Dispose();
            SafeUi(delegate
            {
                session = null;
                activeOperation = null;
                AppendLog(stopResult.ExitCode == 0 ? "Everything stopped." : "Graceful stop failed; Job containment was applied.");
                if (afterStop != null) afterStop();
                if (exitAfter)
                {
                    allowClose = true;
                    Close();
                }
                else
                {
                    SetBusy(false);
                    RefreshStatus();
                }
            });
        });
    }

    private void OnFormClosing(object sender, FormClosingEventArgs eventArgs)
    {
        if (allowClose) return;
        eventArgs.Cancel = true;
        if (closing) return;
        closing = true;
        StopEverything(true, null);
    }

    private void BeginUninstall()
    {
        string helper = Path.Combine(GuiProgram.BinDirectory(), "codex-chatgpt-web-uninstall.ps1");
        if (!File.Exists(helper))
        {
            MessageBox.Show(
                "The uninstaller helper is missing.\r\n\r\nStop this GUI, run:\r\n" +
                "\"" + cliPath + "\" uninstall --yes\r\n\r\nThen remove:\r\n" + GuiProgram.InstallRoot(),
                "Manual removal", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        DialogResult answer = MessageBox.Show(
            "Stop the foreground session and open the per-user uninstaller?",
            "Uninstall Codex ChatGPT Web", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
        if (answer != DialogResult.Yes) return;
        StopEverything(false, delegate
        {
            try
            {
                string windowsPowerShell = Path.Combine(
                    Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
                if (!File.Exists(windowsPowerShell))
                {
                    throw new FileNotFoundException("Windows PowerShell is missing", windowsPowerShell);
                }
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = windowsPowerShell;
                info.Arguments = "-NoProfile -ExecutionPolicy Bypass -File " + QuoteArgument(helper);
                info.WorkingDirectory = GuiProgram.InstallRoot();
                info.UseShellExecute = true;
                Process.Start(info);
                allowClose = true;
                job.Dispose();
                Close();
            }
            catch (Exception error) { ShowError(error.Message); }
        });
    }

    private void OpenGuide()
    {
        string local = Path.Combine(GuiProgram.InstallRoot(), "doc", "WINDOWS_SETUP.md");
        if (File.Exists(local)) OpenTarget(local);
        else OpenTarget("https://github.com/miuuyy/codex-chatgpt-web/blob/main/docs/windows.md");
    }

    private void OpenCodex()
    {
        if (!runtimeReady || closing || busy)
        {
            MessageBox.Show(this,
                "Start the foreground runtime and wait until its status says Running before opening Codex.",
                GuiProgram.ProductName, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        // The current Windows Codex package registers this protocol. Opening
        // the website would bypass the local route configured by this app.
        OpenTarget("codex:");
    }

    private void BeginReadinessPolling()
    {
        if (!cliVersionMatches || closing || runtimeReady || readinessPollingExpired || readinessTimer.Enabled) return;
        readinessDeadlineUtc = DateTime.UtcNow.AddSeconds(ReadinessPollWindowSeconds);
        readinessTimer.Start();
    }

    private void StopReadinessPolling(bool expired)
    {
        readinessTimer.Stop();
        if (expired) readinessPollingExpired = true;
    }

    private void PollReadiness()
    {
        if (closing || runtimeReady)
        {
            StopReadinessPolling(false);
            return;
        }
        if (DateTime.UtcNow >= readinessDeadlineUtc)
        {
            StopReadinessPolling(true);
            if (observedSessionRunning || (session != null && session.IsRunning))
            {
                SetStatus("Needs attention",
                    "The session did not become ready within 30 seconds. Review Live activity and diagnostics.",
                    false);
            }
            return;
        }
        RefreshStatus();
    }

    private void OpenTarget(string target)
    {
        try
        {
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = target;
            info.UseShellExecute = true;
            Process.Start(info);
        }
        catch (Exception error) { ShowError(error.Message); }
    }

    private void SetBusy(bool value)
    {
        busy = value;
        setupButton.Enabled = setupActionAllowed && !value && !closing;
        openCodexButton.Enabled = runtimeReady && !value && !closing;
        startButton.Enabled = setupReady && !value && !observedSessionRunning &&
            (session == null || !session.IsRunning);
        stopButton.Enabled = !closing &&
            (value || observedSessionRunning || activeOperation != null ||
             (session != null && session.IsRunning));
        UseWaitCursor = value;
    }

    private void OnChildLine(string line, bool error)
    {
        string safe = Sanitize(line);
        if (safe.Length == 0) return;
        SafeUi(delegate { AppendLog((error ? "error: " : "") + safe); });
    }

    private string Sanitize(string text)
    {
        if (String.IsNullOrEmpty(text)) return "";
        string secretName =
            "(?:(?:runtime|api)\\s*[_-]?\\s*key(?:\\s*[_-]?\\s*value)?|" +
            "control\\s*[_-]?\\s*token|password)";
        string safe = Regex.Replace(
            text,
            "(?i)([\"']?" + secretName + "[\"']?\\s*[:=]\\s*)" +
            "(?:\"(?:\\\\.|[^\"])*\"|'(?:\\\\.|[^'])*'|\\S+)",
            "$1[redacted]",
            RegexOptions.CultureInvariant);
        safe = Regex.Replace(safe, "(?i)\\b(sk-[A-Za-z0-9_-]{8,})\\b", "[redacted-key]");
        return safe;
    }

    private string SafeFailure(JobChild child)
    {
        return SafeFailure(new CommandResult(child.ExitCode, child.Stdout, child.Stderr));
    }

    private string SafeFailure(CommandResult result)
    {
        string detail = !String.IsNullOrWhiteSpace(result.Stderr) ? result.Stderr : result.Stdout;
        detail = Sanitize(detail).Trim();
        return detail.Length == 0 ? "The command failed with exit code " + result.ExitCode + "." : detail;
    }

    private void AppendLog(string text)
    {
        if (logBox == null || logBox.IsDisposed) return;
        string entry = DateTime.Now.ToString("HH:mm:ss", CultureInfo.CurrentCulture) +
            "  " + text + Environment.NewLine;
        if (entry.Length > MaxLiveLogCharacters)
        {
            entry = entry.Substring(entry.Length - MaxLiveLogCharacters);
        }
        logBox.AppendText(entry);
        if (logBox.TextLength > MaxLiveLogCharacters)
        {
            int remove = logBox.TextLength - RetainedLiveLogCharacters;
            logBox.Select(0, remove);
            logBox.SelectedText = "";
        }
        logBox.SelectionStart = logBox.TextLength;
        logBox.ScrollToCaret();
    }

    private void SafeUi(Action action)
    {
        if (IsDisposed || Disposing) return;
        try
        {
            if (InvokeRequired) BeginInvoke(action);
            else action();
        }
        catch (ObjectDisposedException) { }
        catch (InvalidOperationException) { }
    }

    private void ShowError(string message)
    {
        MessageBox.Show(this, Sanitize(message), GuiProgram.ProductName,
            MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    private sealed class GuiStatusSnapshot
    {
        internal string Version;
        internal string ConfigError;
        internal bool ConfigurationRecoverable;
        internal bool Configured;
        internal bool ConfigurationCurrent;
        internal bool ChromeFound;
        internal bool LoginReady;
        internal bool CodexInstalled;
        internal bool CodexRouteRepairRequired;
        internal bool Running;
        internal bool Healthy;
        internal bool AcceptingTurns;
        internal int ActiveHttpTurns;
        internal int ActiveBrowserTurns;
        internal string Detail;
        internal string Mode;
        internal string ChromePath;
        internal int SetupPort;
        internal string SetupAppName;
        internal bool SetupAutoApprove;
        internal bool TunnelIdConfigured;
        internal bool RuntimeKeyConfigured;
    }

    private bool TryParseGuiStatus(CommandResult result, out GuiStatusSnapshot status)
    {
        status = null;
        if (result.ExitCode != 0 || String.IsNullOrWhiteSpace(result.Stdout) ||
            result.Stdout.Length > 256 * 1024)
        {
            return false;
        }
        try
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = 256 * 1024;
            serializer.RecursionLimit = 24;
            Dictionary<string, object> root =
                serializer.DeserializeObject(result.Stdout) as Dictionary<string, object>;
            if (root == null) return false;
            object value;
            string version;
            bool configured;
            bool current;
            bool recoverable;
            bool login;
            if (!TryStatusString(root, "version", out version) ||
                !TryStatusBoolean(root, "configured", out configured) ||
                !TryStatusBoolean(root, "configurationCurrent", out current) ||
                !TryStatusBoolean(root, "configurationRecoverable", out recoverable) ||
                !TryStatusBoolean(root, "loginReady", out login) ||
                !root.TryGetValue("chrome", out value))
            {
                return false;
            }
            Dictionary<string, object> chrome = value as Dictionary<string, object>;
            bool chromeFound;
            if (chrome == null || !TryStatusBoolean(chrome, "found", out chromeFound) ||
                !root.TryGetValue("session", out value))
            {
                return false;
            }
            Dictionary<string, object> sessionStatus = value as Dictionary<string, object>;
            bool running;
            bool healthy;
            bool acceptingTurns = false;
            if (sessionStatus == null ||
                !TryStatusBoolean(sessionStatus, "running", out running) ||
                !TryStatusBoolean(sessionStatus, "healthy", out healthy))
            {
                return false;
            }
            bool codexInstalled;
            bool codexRouteRepairRequired;
            if (!root.TryGetValue("codex", out value)) return false;
            Dictionary<string, object> codex = value as Dictionary<string, object>;
            if (codex == null ||
                !TryStatusBoolean(codex, "installed", out codexInstalled) ||
                !TryStatusBoolean(codex, "repairRequired", out codexRouteRepairRequired))
            {
                return false;
            }
            string configError = null;
            if (root.TryGetValue("configError", out value))
            {
                configError = value as string;
                if (configError == null) return false;
                configError = configError.Trim();
                if (configError.Length == 0) configError = null;
            }
            string mode = null;
            if (root.TryGetValue("mode", out value))
            {
                mode = value as string;
                if (mode != "browser-only" && mode != "full") return false;
            }
            string configuredChromePath;
            if (!TryStatusString(chrome, "path", out configuredChromePath)) return false;
            int setupPort = 0;
            string setupAppName = null;
            bool setupAutoApprove = false;
            bool tunnelIdConfigured = false;
            bool runtimeKeyConfigured = false;
            if (root.TryGetValue("setup", out value))
            {
                Dictionary<string, object> setup = value as Dictionary<string, object>;
                object credentialsValue;
                if (setup == null ||
                    !TryStatusInteger(setup, "port", 1, 65535, out setupPort) ||
                    !TryStatusString(setup, "appName", out setupAppName) ||
                    !TryStatusBoolean(setup, "autoApproveToolCalls", out setupAutoApprove) ||
                    !setup.TryGetValue("fullCredentials", out credentialsValue))
                {
                    return false;
                }
                Dictionary<string, object> credentials = credentialsValue as Dictionary<string, object>;
                if (credentials == null ||
                    !TryStatusBoolean(credentials, "tunnelIdConfigured", out tunnelIdConfigured) ||
                    !TryStatusBoolean(credentials, "runtimeKeyConfigured", out runtimeKeyConfigured))
                {
                    return false;
                }
            }
            status = new GuiStatusSnapshot();
            status.Version = version;
            status.ConfigError = configError;
            status.ConfigurationRecoverable = recoverable;
            status.Configured = configured;
            status.ConfigurationCurrent = current;
            status.ChromeFound = chromeFound;
            status.LoginReady = login;
            status.CodexInstalled = codexInstalled;
            status.CodexRouteRepairRequired = codexRouteRepairRequired;
            status.Running = running;
            status.Healthy = healthy;
            if (running)
            {
                TryStatusBoolean(sessionStatus, "acceptingTurns", out acceptingTurns);
            }
            status.AcceptingTurns = acceptingTurns;
            status.ActiveHttpTurns = StatusCount(sessionStatus, "activeHttpTurns");
            status.ActiveBrowserTurns = StatusCount(sessionStatus, "activeBrowserTurns");
            status.Mode = mode;
            status.ChromePath = configuredChromePath;
            status.SetupPort = setupPort;
            status.SetupAppName = setupAppName;
            status.SetupAutoApprove = setupAutoApprove;
            status.TunnelIdConfigured = tunnelIdConfigured;
            status.RuntimeKeyConfigured = runtimeKeyConfigured;
            if (sessionStatus.TryGetValue("detail", out value))
            {
                status.Detail = value as string;
            }
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool TryStatusBoolean(
        Dictionary<string, object> values,
        string key,
        out bool result)
    {
        object value;
        result = false;
        if (!values.TryGetValue(key, out value) || !(value is bool)) return false;
        result = (bool)value;
        return true;
    }

    private static bool TryStatusString(
        Dictionary<string, object> values,
        string key,
        out string result)
    {
        object value;
        result = null;
        if (!values.TryGetValue(key, out value)) return false;
        result = value as string;
        if (String.IsNullOrWhiteSpace(result)) return false;
        result = result.Trim();
        return true;
    }

    private static bool TryStatusInteger(
        Dictionary<string, object> values,
        string key,
        int minimum,
        int maximum,
        out int result)
    {
        object value;
        result = 0;
        if (!values.TryGetValue(key, out value)) return false;
        if (value is int) result = (int)value;
        else if (value is long && (long)value >= Int32.MinValue && (long)value <= Int32.MaxValue)
            result = (int)(long)value;
        else return false;
        return result >= minimum && result <= maximum;
    }

    private static int StatusCount(Dictionary<string, object> values, string key)
    {
        object value;
        if (!values.TryGetValue(key, out value)) return 0;
        if (value is int) return Math.Max(0, (int)value);
        if (value is long)
        {
            long count = (long)value;
            return count > Int32.MaxValue ? Int32.MaxValue : Math.Max(0, (int)count);
        }
        return 0;
    }

    private static string QuoteArgument(string value)
    {
        return NativeJob.QuoteArgument(value);
    }

    private sealed class CommandResult
    {
        internal readonly int ExitCode;
        internal readonly string Stdout;
        internal readonly string Stderr;
        internal CommandResult(int exitCode, string stdout, string stderr)
        {
            ExitCode = exitCode;
            Stdout = stdout ?? "";
            Stderr = stderr ?? "";
        }
    }
}

internal sealed class BrandMark : Control
{
    internal BrandMark()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
        AccessibleName = "Codex ChatGPT Web";
        TabStop = false;
    }

    protected override void OnPaint(PaintEventArgs eventArgs)
    {
        base.OnPaint(eventArgs);
        eventArgs.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        Rectangle area = new Rectangle(2, 2, Width - 5, Height - 5);
        using (Pen ring = new Pen(Color.FromArgb(96, 165, 250), 4F))
        {
            eventArgs.Graphics.DrawArc(ring, area, 30, 285);
        }
        using (Pen inner = new Pen(Color.White, 3F))
        {
            Rectangle inset = Rectangle.Inflate(area, -10, -10);
            eventArgs.Graphics.DrawArc(inner, inset, 205, 285);
        }
        using (SolidBrush dot = new SolidBrush(Color.FromArgb(52, 211, 153)))
        {
            eventArgs.Graphics.FillEllipse(dot, Width - 14, Height - 14, 10, 10);
        }
    }
}

internal sealed class NativeJob : IDisposable
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESHOWWINDOW = 0x00000001;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private readonly object sync = new object();
    private readonly List<JobChild> children = new List<JobChild>();
    private static readonly HashSet<string> SensitiveChildEnvironmentVariables =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
            "CODEX_ACCESS_TOKEN"
        };
    private IntPtr jobHandle;
    private bool disposed;

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        internal int nLength;
        internal IntPtr lpSecurityDescriptor;
        internal int bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        internal int cb;
        internal string lpReserved;
        internal string lpDesktop;
        internal string lpTitle;
        internal uint dwX;
        internal uint dwY;
        internal uint dwXSize;
        internal uint dwYSize;
        internal uint dwXCountChars;
        internal uint dwYCountChars;
        internal uint dwFillAttribute;
        internal uint dwFlags;
        internal short wShowWindow;
        internal short cbReserved2;
        internal IntPtr lpReserved2;
        internal IntPtr hStdInput;
        internal IntPtr hStdOutput;
        internal IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        internal IntPtr hProcess;
        internal IntPtr hThread;
        internal uint dwProcessId;
        internal uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        internal long PerProcessUserTimeLimit;
        internal long PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal UIntPtr MinimumWorkingSetSize;
        internal UIntPtr MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass;
        internal uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        internal ulong ReadOperationCount;
        internal ulong WriteOperationCount;
        internal ulong OtherOperationCount;
        internal ulong ReadTransferCount;
        internal ulong WriteTransferCount;
        internal ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        internal JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        internal IO_COUNTERS IoInfo;
        internal UIntPtr ProcessMemoryLimit;
        internal UIntPtr JobMemoryLimit;
        internal UIntPtr PeakProcessMemoryUsed;
        internal UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass,
        IntPtr information, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags,
        IntPtr environment, string currentDirectory, ref STARTUPINFO startup,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe,
        ref SECURITY_ATTRIBUTES attributes, uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool CloseHandle(IntPtr handle);

    internal NativeJob()
    {
        jobHandle = CreateJobObject(IntPtr.Zero, null);
        if (jobHandle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(jobHandle, JobObjectExtendedLimitInformation, buffer, (uint)size))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
            }
        }
        catch
        {
            CloseHandle(jobHandle);
            jobHandle = IntPtr.Zero;
            throw;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    internal JobChild Start(string executable, string[] arguments, string input,
        Action<string, bool> output)
    {
        // Security-equivalent to ProcessStartInfo.RedirectStandardInput = true:
        // the child receives only the inherited anonymous stdin pipe created below.
        executable = Path.GetFullPath(executable);
        if (!File.Exists(executable)) throw new FileNotFoundException("Executable is missing", executable);
        lock (sync)
        {
            if (disposed) throw new ObjectDisposedException("NativeJob");
        }

        IntPtr stdoutRead = IntPtr.Zero, stdoutWrite = IntPtr.Zero;
        IntPtr stderrRead = IntPtr.Zero, stderrWrite = IntPtr.Zero;
        IntPtr stdinRead = IntPtr.Zero, stdinWrite = IntPtr.Zero;
        IntPtr environmentBlock = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES();
        security.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
        security.bInheritHandle = 1;
        try
        {
            CreatePipeChecked(out stdoutRead, out stdoutWrite, ref security);
            CreatePipeChecked(out stderrRead, out stderrWrite, ref security);
            CreatePipeChecked(out stdinRead, out stdinWrite, ref security);
            if (!SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0) ||
                !SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0) ||
                !SetHandleInformation(stdinWrite, HANDLE_FLAG_INHERIT, 0))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetHandleInformation failed");
            }

            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
            startup.wShowWindow = 0;
            startup.hStdInput = stdinRead;
            startup.hStdOutput = stdoutWrite;
            startup.hStdError = stderrWrite;
            StringBuilder commandLine = new StringBuilder(QuoteArgument(executable));
            foreach (string argument in arguments)
            {
                commandLine.Append(' ').Append(QuoteArgument(argument));
            }
            environmentBlock = BuildChildEnvironmentBlock();
            if (!CreateProcess(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                environmentBlock, Path.GetDirectoryName(executable),
                ref startup, out process))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess failed");
            }
            if (!AssignProcessToJobObject(jobHandle, process.hProcess))
            {
                TerminateProcess(process.hProcess, 1);
                throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
            }
            if (ResumeThread(process.hThread) == 0xFFFFFFFF)
            {
                TerminateProcess(process.hProcess, 1);
                throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed");
            }

            CloseHandle(process.hThread);
            process.hThread = IntPtr.Zero;
            CloseHandle(stdoutWrite); stdoutWrite = IntPtr.Zero;
            CloseHandle(stderrWrite); stderrWrite = IntPtr.Zero;
            CloseHandle(stdinRead); stdinRead = IntPtr.Zero;
            using (FileStream stream = new FileStream(new SafeFileHandle(stdinWrite, true), FileAccess.Write, 4096, false))
            using (StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false)))
            {
                stdinWrite = IntPtr.Zero;
                if (input != null) writer.Write(input);
            }

            JobChild child = new JobChild(this, process.hProcess, unchecked((int)process.dwProcessId),
                stdoutRead, stderrRead, output);
            process.hProcess = IntPtr.Zero;
            stdoutRead = IntPtr.Zero;
            stderrRead = IntPtr.Zero;
            lock (sync) children.Add(child);
            child.Begin();
            return child;
        }
        catch
        {
            if (process.hProcess != IntPtr.Zero) { TerminateProcess(process.hProcess, 1); CloseHandle(process.hProcess); }
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            CloseIfValid(stdoutRead); CloseIfValid(stdoutWrite);
            CloseIfValid(stderrRead); CloseIfValid(stderrWrite);
            CloseIfValid(stdinRead); CloseIfValid(stdinWrite);
            throw;
        }
        finally
        {
            if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
        }
    }

    private static IntPtr BuildChildEnvironmentBlock()
    {
        List<string> entries = new List<string>();
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            string name = entry.Key as string;
            if (String.IsNullOrEmpty(name) || SensitiveChildEnvironmentVariables.Contains(name)) continue;
            entries.Add(name + "=" + Convert.ToString(entry.Value, CultureInfo.InvariantCulture));
        }
        entries.Sort(StringComparer.OrdinalIgnoreCase);
        return Marshal.StringToHGlobalUni(String.Join("\0", entries.ToArray()) + "\0\0");
    }

    private static void CreatePipeChecked(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES security)
    {
        if (!CreatePipe(out read, out write, ref security, 0))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe failed");
        }
    }

    private static void CloseIfValid(IntPtr handle)
    {
        if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
    }

    internal void ChildCompleted(JobChild child)
    {
        lock (sync) children.Remove(child);
    }

    internal void TerminateExcept(JobChild exception, uint exitCode)
    {
        JobChild[] snapshot;
        lock (sync) snapshot = children.ToArray();
        foreach (JobChild child in snapshot)
        {
            if (!Object.ReferenceEquals(child, exception)) child.Terminate(exitCode);
        }
    }

    internal void TerminateAll(uint exitCode)
    {
        IntPtr handle;
        lock (sync) handle = jobHandle;
        if (handle != IntPtr.Zero) TerminateJobObject(handle, exitCode);
    }

    public void Dispose()
    {
        IntPtr handle;
        lock (sync)
        {
            if (disposed) return;
            disposed = true;
            handle = jobHandle;
            jobHandle = IntPtr.Zero;
        }
        if (handle != IntPtr.Zero) CloseHandle(handle);
    }

    internal static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
        StringBuilder quoted = new StringBuilder();
        quoted.Append('"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { backslashes++; continue; }
            if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1).Append('"');
                backslashes = 0;
                continue;
            }
            quoted.Append('\\', backslashes);
            backslashes = 0;
            quoted.Append(character);
        }
        quoted.Append('\\', backslashes * 2).Append('"');
        return quoted.ToString();
    }
}

internal sealed class JobChild
{
    private const int MaxCapturedCharacters = 1024 * 1024;
    private const int RetainedCapturedCharacters = 900 * 1024;
    private readonly NativeJob owner;
    private readonly object sync = new object();
    private readonly IntPtr processHandle;
    private readonly int processId;
    private readonly IntPtr stdoutRead;
    private readonly IntPtr stderrRead;
    private readonly Action<string, bool> output;
    private readonly ManualResetEvent completed = new ManualResetEvent(false);
    private readonly StringBuilder stdout = new StringBuilder();
    private readonly StringBuilder stderr = new StringBuilder();
    private int exitCode = -1;
    private bool begun;

    private Action<JobChild> completedHandlers;
    internal event Action<JobChild> Completed
    {
        add
        {
            bool invokeNow;
            lock (sync)
            {
                invokeNow = completed.WaitOne(0);
                if (!invokeNow) completedHandlers += value;
            }
            if (invokeNow) value(this);
        }
        remove
        {
            lock (sync) completedHandlers -= value;
        }
    }

    internal JobChild(NativeJob owner, IntPtr processHandle, int processId,
        IntPtr stdoutRead, IntPtr stderrRead, Action<string, bool> output)
    {
        this.owner = owner;
        this.processHandle = processHandle;
        this.processId = processId;
        this.stdoutRead = stdoutRead;
        this.stderrRead = stderrRead;
        this.output = output;
    }

    internal int ProcessId { get { return processId; } }
    internal int ExitCode { get { return exitCode; } }
    internal bool IsRunning { get { return !completed.WaitOne(0); } }
    internal string Stdout { get { lock (sync) return stdout.ToString(); } }
    internal string Stderr { get { lock (sync) return stderr.ToString(); } }

    internal void Begin()
    {
        if (begun) return;
        begun = true;
        Thread stdoutThread = ReaderThread(stdoutRead, false);
        Thread stderrThread = ReaderThread(stderrRead, true);
        Thread waiter = new Thread(delegate()
        {
            NativeJob.WaitForSingleObject(processHandle, 0xFFFFFFFF);
            uint code;
            if (NativeJob.GetExitCodeProcess(processHandle, out code)) exitCode = unchecked((int)code);
            stdoutThread.Join(3000);
            stderrThread.Join(3000);
            NativeJob.CloseHandle(processHandle);
            owner.ChildCompleted(this);
            completed.Set();
            Action<JobChild> callback;
            lock (sync) callback = completedHandlers;
            if (callback != null) callback(this);
        });
        waiter.IsBackground = true;
        waiter.Name = "Codex GUI process waiter";
        waiter.Start();
    }

    private Thread ReaderThread(IntPtr handle, bool error)
    {
        Thread thread = new Thread(delegate()
        {
            using (FileStream stream = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read, 4096, false))
            using (StreamReader reader = new StreamReader(stream, Encoding.UTF8, true))
            {
                char[] buffer = new char[4096];
                int count;
                while ((count = reader.Read(buffer, 0, buffer.Length)) > 0)
                {
                    string chunk = new string(buffer, 0, count);
                    lock (sync)
                    {
                        AppendBounded(error ? stderr : stdout, chunk);
                    }
                    if (output != null) output(chunk, error);
                }
            }
        });
        thread.IsBackground = true;
        thread.Name = error ? "Codex GUI stderr" : "Codex GUI stdout";
        thread.Start();
        return thread;
    }

    private static void AppendBounded(StringBuilder destination, string value)
    {
        destination.Append(value);
        if (destination.Length > MaxCapturedCharacters)
        {
            destination.Remove(0, destination.Length - RetainedCapturedCharacters);
        }
    }

    internal bool Wait(int milliseconds)
    {
        return completed.WaitOne(milliseconds < 0 ? Timeout.Infinite : milliseconds);
    }

    internal void Terminate(uint code)
    {
        if (!completed.WaitOne(0)) NativeJob.TerminateProcess(processHandle, code);
    }
}
