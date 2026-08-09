using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Threading;

internal static class WindowsGuiLifecycleProbe
{
    private const string GrandchildFlag = "--grandchild";

    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == GrandchildFlag)
        {
            Thread.Sleep(Timeout.Infinite);
            return 0;
        }
        if (args.Length != 1)
        {
            Console.Error.WriteLine("usage: windows-gui-lifecycle-probe.exe PID_FILE");
            return 2;
        }

        foreach (string name in new[] { "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN" })
        {
            if (!String.IsNullOrEmpty(Environment.GetEnvironmentVariable(name)))
            {
                Console.Error.WriteLine("sensitive authentication environment reached GUI child");
                return 4;
            }
        }

        string executable = Assembly.GetExecutingAssembly().Location;
        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = executable;
        start.Arguments = GrandchildFlag;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        Process child = Process.Start(start);
        if (child == null)
        {
            Console.Error.WriteLine("could not create lifecycle grandchild");
            return 3;
        }

        string payload = Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture)
            + Environment.NewLine
            + child.Id.ToString(CultureInfo.InvariantCulture)
            + Environment.NewLine;
        File.WriteAllText(args[0], payload);
        Thread.Sleep(Timeout.Infinite);
        return 0;
    }
}
