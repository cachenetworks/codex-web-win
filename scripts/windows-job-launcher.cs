using System;
using System.ComponentModel;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class WindowsJobLauncher
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const string InternalSuperviseFlag = "--codex-chatgpt-web-internal-supervise";
    private const string LauncherConfigurationName = "codex-chatgpt-web.launcher";
    private static IntPtr activeJob = IntPtr.Zero;
    private static int cancellationCount;
    private static Timer hardStopTimer;

    private sealed class LaunchConfiguration
    {
        public string Executable;
        public string Entrypoint;
        public string[] Arguments;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public int bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    private static string DecodeConfigurationValue(string value)
    {
        return Encoding.UTF8.GetString(Convert.FromBase64String(value));
    }

    private static LaunchConfiguration ResolveLaunch(string[] args)
    {
        if (args.Length >= 3 && args[0] == InternalSuperviseFlag)
        {
            string[] internalArguments = new string[args.Length - 3];
            Array.Copy(args, 3, internalArguments, 0, internalArguments.Length);
            return new LaunchConfiguration
            {
                Executable = args[1],
                Entrypoint = args[2],
                Arguments = internalArguments
            };
        }

        string launcher = Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
        string launcherDirectory = Path.GetDirectoryName(launcher);
        string configurationPath = Path.Combine(launcherDirectory, LauncherConfigurationName);
        string executable;
        string entrypoint;
        if (File.Exists(configurationPath))
        {
            string[] lines = File.ReadAllLines(configurationPath, Encoding.UTF8);
            if (lines.Length != 4 || lines[0] != "v1")
            {
                throw new InvalidDataException("Invalid Windows launcher configuration");
            }
            executable = DecodeConfigurationValue(lines[1]);
            entrypoint = DecodeConfigurationValue(lines[2]);
            string appHome = DecodeConfigurationValue(lines[3]);
            Environment.SetEnvironmentVariable("CODEX_CHATGPT_WEB_HOME", appHome);
        }
        else
        {
            string bundleRoot = Path.GetFullPath(Path.Combine(launcherDirectory, ".."));
            executable = Path.Combine(bundleRoot, "runtime", "node.exe");
            entrypoint = Path.Combine(bundleRoot, "app", "cli.js");
        }
        if (!File.Exists(executable))
        {
            throw new FileNotFoundException("Windows runtime executable is missing", executable);
        }
        if (!File.Exists(entrypoint))
        {
            throw new FileNotFoundException("Windows runtime entrypoint is missing", entrypoint);
        }

        Environment.SetEnvironmentVariable("CODEX_CHATGPT_WEB_LAUNCHER", launcher);
        Environment.SetEnvironmentVariable("CODEX_CHATGPT_WEB_RUNTIME", executable);
        Environment.SetEnvironmentVariable("CODEX_CHATGPT_WEB_ENTRYPOINT", entrypoint);
        return new LaunchConfiguration
        {
            Executable = executable,
            Entrypoint = entrypoint,
            Arguments = args
        };
    }

    private static void CloseActiveJob()
    {
        IntPtr job = Interlocked.Exchange(ref activeJob, IntPtr.Zero);
        if (job != IntPtr.Zero)
        {
            CloseHandle(job);
        }
    }

    private static void HandleCancel(object sender, ConsoleCancelEventArgs eventArgs)
    {
        eventArgs.Cancel = true;
        if (Interlocked.Increment(ref cancellationCount) == 1)
        {
            Console.Error.WriteLine("Stopping codex-chatgpt-web; press Ctrl+C again to force termination.");
            hardStopTimer = new Timer(delegate(object state) { CloseActiveJob(); }, null, 10000, Timeout.Infinite);
        }
        else
        {
            CloseActiveJob();
        }
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return value;
        }

        StringBuilder quoted = new StringBuilder();
        quoted.Append('"');
        int backslashes = 0;
        foreach (char character in value)
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

    private static string BuildCommandLine(string executable, string entrypoint, string[] arguments)
    {
        StringBuilder command = new StringBuilder();
        command.Append(QuoteArgument(executable));
        command.Append(' ');
        command.Append(QuoteArgument(entrypoint));
        foreach (string argument in arguments)
        {
            command.Append(' ');
            command.Append(QuoteArgument(argument));
        }
        return command.ToString();
    }

    private static void ConfigureKillOnClose(IntPtr job)
    {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static int Main(string[] args)
    {
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool childCreated = false;
        bool childAssigned = false;
        try
        {
            LaunchConfiguration launch = ResolveLaunch(args);
            Console.CancelKeyPress += HandleCancel;

            activeJob = CreateJobObject(IntPtr.Zero, null);
            if (activeJob == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
            }
            ConfigureKillOnClose(activeJob);

            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            // The supervisor may itself have been launched with anonymous
            // pipes by the native GUI. Forward those exact handles to Node;
            // inheriting handles alone does not populate a child's STARTUPINFO
            // when no console is attached.
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
            startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
            StringBuilder commandLine = new StringBuilder(BuildCommandLine(launch.Executable, launch.Entrypoint, launch.Arguments));
            if (!CreateProcess(
                launch.Executable,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED,
                IntPtr.Zero,
                null,
                ref startup,
                out process))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess failed");
            }
            childCreated = true;

            if (!AssignProcessToJobObject(activeJob, process.hProcess))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
            }
            childAssigned = true;

            if (ResumeThread(process.hThread) == 0xFFFFFFFF)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed");
            }

            uint wait = WaitForSingleObject(process.hProcess, INFINITE);
            if (wait != 0)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject failed");
            }
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetExitCodeProcess failed");
            }
            return unchecked((int)exitCode);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("codex-chatgpt-web supervisor: " + error.Message);
            if (childCreated && !childAssigned)
            {
                TerminateProcess(process.hProcess, 1);
            }
            return 1;
        }
        finally
        {
            if (process.hThread != IntPtr.Zero)
            {
                CloseHandle(process.hThread);
            }
            if (process.hProcess != IntPtr.Zero)
            {
                CloseHandle(process.hProcess);
            }
            if (hardStopTimer != null)
            {
                hardStopTimer.Dispose();
            }
            CloseActiveJob();
        }
    }
}
