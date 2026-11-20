using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Management;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace DshWechatRestart {
  internal sealed class DesktopProcess {
    public int Pid;
    public int ParentPid;
    public string Path;
    public int Depth;
  }

  internal static class Program {
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private const string DesktopName = "DeepSeek Harness.exe";
    private const int StdOutput = -11;
    private const int StdError = -12;
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint TokenQuery = 0x0008;
    private const int TokenElevationClass = 20;

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenElevationInfo { public int TokenIsElevated; }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, int processId);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int tokenClass,
      out TokenElevationInfo elevation, int size, out int returnedLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static bool IsProcessElevated(int pid) {
      IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, pid);
      if (process == IntPtr.Zero)
        throw new InvalidOperationException("desktop-process-token-unavailable");
      try {
        IntPtr token;
        if (!OpenProcessToken(process, TokenQuery, out token))
          throw new InvalidOperationException("desktop-token-unavailable");
        try {
          TokenElevationInfo elevation;
          int returnedLength;
          if (!GetTokenInformation(token, TokenElevationClass, out elevation,
              Marshal.SizeOf(typeof(TokenElevationInfo)), out returnedLength))
            throw new InvalidOperationException("desktop-elevation-check-failed");
          return elevation.TokenIsElevated != 0;
        } finally { CloseHandle(token); }
      } finally { CloseHandle(process); }
    }


    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WriteFile(IntPtr handle, byte[] buffer, uint count, out uint written, IntPtr overlapped);

    [STAThread]
    private static int Main(string[] args) {
      try {
        if (args == null || args.Length == 0) return Fail("missing-mode", 2);
        string mode = args[0].ToLowerInvariant();
        if (mode == "--check") return Check();
        if (mode == "--check-clean" && args.Length == 2) return CheckClean(args[1]);
        if (mode == "--schedule" && args.Length == 2) return Schedule(args[1]);
        if (mode == "--execute" && args.Length == 2) return Execute(args[1]);
        if (mode == "--cleanup" && args.Length == 2) return Cleanup(args[1]);
        if (mode == "--probe-task" && args.Length == 2) return ProbeTask(args[1], 0);
        if (mode == "--probe-task-high" && args.Length == 2) return ProbeTask(args[1], 1);
        if (mode == "--probe-long" && args.Length == 3) return ProbeLong(args[1], args[2]);
        if (mode == "--probe-self-delete" && args.Length == 3) return ProbeSelfDelete(args[1], args[2]);
        return Fail("invalid-arguments", 2);
      } catch {
        return Fail("restart-helper-failed", 1);
      }
    }

    private static void Output(object value) {
      byte[] bytes = new UTF8Encoding(false).GetBytes(Json.Serialize(value) + "\n");
      uint written;
      IntPtr handle = GetStdHandle(StdOutput);
      if (handle != IntPtr.Zero && handle != new IntPtr(-1)) WriteFile(handle, bytes, (uint)bytes.Length, out written, IntPtr.Zero);
    }

    private static int Fail(string code, int exitCode) {
      byte[] bytes = Encoding.UTF8.GetBytes(code + "\n");
      uint written;
      IntPtr handle = GetStdHandle(StdError);
      if (handle != IntPtr.Zero && handle != new IntPtr(-1)) WriteFile(handle, bytes, (uint)bytes.Length, out written, IntPtr.Zero);
      return exitCode;
    }

    private static string HelperPath {
      get { return Path.GetFullPath(Assembly.GetExecutingAssembly().Location); }
    }

    private static long UtcMs() {
      return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
    }

    private static string Text(Dictionary<string, object> ticket, string key) {
      object value;
      return ticket.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : "";
    }

    private static long Number(Dictionary<string, object> ticket, string key) {
      object value;
      return ticket.TryGetValue(key, out value) && value != null ? Convert.ToInt64(value) : 0L;
    }

    private static void Put(Dictionary<string, object> ticket, string key, object value) {
      ticket[key] = value;
    }

    private static Dictionary<string, object> ReadTicket(string path) {
      if (String.IsNullOrWhiteSpace(path) || !Path.IsPathRooted(path) || path.IndexOf('"') >= 0)
        throw new InvalidOperationException("invalid-ticket-path");
      Dictionary<string, object> ticket = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
      Guid id;
      if (ticket == null || !ticket.ContainsKey("version") || Number(ticket, "version") != 1
        || !Guid.TryParse(Text(ticket, "requestId"), out id))
        throw new InvalidOperationException("invalid-ticket");
      return ticket;
    }

    private static void WriteTicket(string path, Dictionary<string, object> ticket) {
      string suffix = Guid.NewGuid().ToString("N");
      string temp = path + ".native-" + suffix + ".tmp";
      string backup = path + ".native-" + suffix + ".bak";
      try {
        File.WriteAllText(temp, Json.Serialize(ticket), new UTF8Encoding(false));
        if (File.Exists(path)) File.Replace(temp, path, backup);
        else File.Move(temp, path);
      } finally {
        try { if (File.Exists(temp)) File.Delete(temp); } catch { }
        try { if (File.Exists(backup)) File.Delete(backup); } catch { }
      }
    }

    private static List<DesktopProcess> GetDesktopProcesses(string exactPath) {
      List<DesktopProcess> result = new List<DesktopProcess>();
      using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
        "SELECT ProcessId, ParentProcessId, ExecutablePath FROM Win32_Process WHERE Name = '" + DesktopName + "'")) {
        using (ManagementObjectCollection rows = searcher.Get()) {
          foreach (ManagementObject row in rows) {
            string path = row["ExecutablePath"] == null ? "" : Convert.ToString(row["ExecutablePath"]);
            if (String.IsNullOrEmpty(path)) continue;
            if (!String.IsNullOrEmpty(exactPath) && !String.Equals(path, exactPath, StringComparison.OrdinalIgnoreCase)) continue;
            result.Add(new DesktopProcess {
              Pid = Convert.ToInt32(row["ProcessId"]),
              ParentPid = Convert.ToInt32(row["ParentProcessId"]),
              Path = path
            });
          }
        }
      }
      return result;
    }

    private static List<DesktopProcess> GetRoots(List<DesktopProcess> processes) {
      HashSet<int> ids = new HashSet<int>(processes.Select(p => p.Pid));
      return processes.Where(p => !ids.Contains(p.ParentPid)).ToList();
    }

    private static DesktopProcess GetDesktopMain(string expectedPath = null) {
      List<DesktopProcess> all = GetDesktopProcesses(expectedPath);
      if (all.Count == 0) throw new InvalidOperationException("desktop-not-running");
      List<DesktopProcess> roots = GetRoots(all);
      if (roots.Count != 1) throw new InvalidOperationException("desktop-root-ambiguous");
      DesktopProcess main = roots[0];
      string folder = Path.GetDirectoryName(main.Path);
      if (!String.Equals(Path.GetFileName(main.Path), DesktopName, StringComparison.OrdinalIgnoreCase)
        || !File.Exists(Path.Combine(folder, "resources", "app.asar")))
        throw new InvalidOperationException("desktop-bundle-missing");
      return main;
    }

    private static List<DesktopProcess> GetDesktopTree(int mainPid, string exePath) {
      List<DesktopProcess> all = GetDesktopProcesses(exePath);
      Dictionary<int, int> depths = new Dictionary<int, int>();
      depths[mainPid] = 0;
      bool updated = true;
      for (int i = 0; i < all.Count && updated; i++) {
        updated = false;
        foreach (DesktopProcess item in all) {
          if (!depths.ContainsKey(item.Pid) && depths.ContainsKey(item.ParentPid)) {
            depths[item.Pid] = depths[item.ParentPid] + 1;
            updated = true;
          }
        }
      }
      if (depths.Count != all.Count) throw new InvalidOperationException("desktop-tree-incomplete");
      foreach (DesktopProcess item in all) item.Depth = depths[item.Pid];
      return all.OrderByDescending(p => p.Depth).ToList();
    }

    private static DesktopProcess GetProcess(int pid) {
      using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
        "SELECT ProcessId, ParentProcessId, ExecutablePath FROM Win32_Process WHERE ProcessId = " + pid)) {
        using (ManagementObjectCollection rows = searcher.Get()) {
          foreach (ManagementObject row in rows) {
            return new DesktopProcess {
              Pid = Convert.ToInt32(row["ProcessId"]),
              ParentPid = Convert.ToInt32(row["ParentProcessId"]),
              Path = row["ExecutablePath"] == null ? "" : Convert.ToString(row["ExecutablePath"])
            };
          }
        }
      }
      return null;
    }

    private static int Check() {
      try {
        DesktopProcess main = GetDesktopMain();
        List<DesktopProcess> tree = GetDesktopTree(main.Pid, main.Path);
        Output(new Dictionary<string, object> {
          { "pid", main.Pid }, { "exePath", main.Path }, { "treeCount", tree.Count }
        });
        return 0;
      } catch (InvalidOperationException error) {
        if (error.Message == "desktop-not-running") return Fail("desktop-not-running", 10);
        if (error.Message == "desktop-root-ambiguous") return Fail("desktop-root-ambiguous", 11);
        if (error.Message == "desktop-bundle-missing") return Fail("desktop-bundle-missing", 12);
        return Fail("desktop-check-failed", 13);
      } catch {
        return Fail("desktop-check-failed", 13);
      }
    }

    private static object ConnectScheduler(out object serviceObject, out object rootObject) {
      Type serviceType = Type.GetTypeFromProgID("Schedule.Service");
      if (serviceType == null) throw new InvalidOperationException("task-scheduler-unavailable");
      dynamic service = Activator.CreateInstance(serviceType);
      service.Connect();
      dynamic root = service.GetFolder("\\");
      serviceObject = service;
      rootObject = root;
      return root;
    }

    private static void ReleaseCom(object value) {
      try { if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value); } catch { }
    }

    private static bool TaskExists(string name) {
      object service = null, root = null;
      try {
        dynamic folder = ConnectScheduler(out service, out root);
        try { object task = folder.GetTask(name); ReleaseCom(task); return true; }
        catch (COMException) { return false; }
        catch (FileNotFoundException) { return false; }
      } finally {
        ReleaseCom(root);
        ReleaseCom(service);
      }
    }

    private static void DeleteTask(string name) {
      if (String.IsNullOrEmpty(name)) return;
      object service = null, root = null;
      try {
        dynamic folder = ConnectScheduler(out service, out root);
        try { folder.DeleteTask(name, 0); }
        catch (COMException) {
          if (TaskExists(name)) throw new InvalidOperationException("restart-task-delete-failed");
        }
        catch (FileNotFoundException) {
          if (TaskExists(name)) throw new InvalidOperationException("restart-task-delete-failed");
        }
      } finally {
        ReleaseCom(root);
        ReleaseCom(service);
      }
      if (TaskExists(name)) throw new InvalidOperationException("restart-task-residue");
    }

    private static void RegisterTask(string name, string actionPath, string actionArguments,
      DateTime? triggerAt, string executionTimeLimit, bool runNow, int runLevel = 0) {
      object service = null, root = null;
      dynamic definition = null, action = null, task = null, running = null, trigger = null;
      string stage = "connect";
      try {
        dynamic folder = ConnectScheduler(out service, out root);
        stage = "new-definition";
        definition = ((dynamic)service).NewTask(0);
        definition.RegistrationInfo.Description = "Temporary one-shot DSH Desktop restart operation";
        definition.Settings.Enabled = true;
        definition.Settings.Hidden = true;
        definition.Settings.AllowDemandStart = true;
        definition.Settings.StartWhenAvailable = false;
        definition.Settings.ExecutionTimeLimit = executionTimeLimit;
        definition.Settings.DisallowStartIfOnBatteries = false;
        definition.Settings.StopIfGoingOnBatteries = false;
        definition.Settings.MultipleInstances = 2;
        definition.Principal.UserId = WindowsIdentity.GetCurrent().Name;
        definition.Principal.LogonType = 3;
        definition.Principal.RunLevel = runLevel;
        if (triggerAt.HasValue) {
          stage = "create-trigger";
          trigger = definition.Triggers.Create(1);
          trigger.StartBoundary = triggerAt.Value.ToLocalTime().ToString("s");
          trigger.Enabled = true;
        }
        stage = "create-action";
        action = definition.Actions.Create(0);
        action.Path = actionPath;
        action.Arguments = actionArguments;
        action.WorkingDirectory = Path.GetDirectoryName(actionPath);
        stage = "register-definition";
        folder.RegisterTaskDefinition(name, definition, 6, null, null, 3, null);
        if (runNow) {
          stage = "get-task";
          task = folder.GetTask(name);
          stage = "run-task";
          running = task.Run(null);
        }
      } catch (Exception error) {
        throw new InvalidOperationException("task-" + stage + ":" + error.GetType().Name + ":" + error.Message);
      } finally {
        ReleaseCom(running);
        ReleaseCom(task);
        ReleaseCom(action);
        ReleaseCom(trigger);
        ReleaseCom(definition);
        ReleaseCom(root);
        ReleaseCom(service);
      }
    }

    private static void RunTask(string name) {
      object service = null, root = null, task = null, running = null;
      try {
        dynamic folder = ConnectScheduler(out service, out root);
        task = folder.GetTask(name);
        running = ((dynamic)task).Run(null);
      } finally {
        ReleaseCom(running);
        ReleaseCom(task);
        ReleaseCom(root);
        ReleaseCom(service);
      }
    }

    private static string BaseTaskName(string requestId) {
      Guid id;
      if (!Guid.TryParse(requestId, out id)) throw new InvalidOperationException("invalid-request-id");
      return "DSHWechatRestart-" + id.ToString("N");
    }

    private static string WorkerTaskName(string requestId) { return BaseTaskName(requestId) + "-worker"; }
    private static string DesktopTaskName(string requestId) { return BaseTaskName(requestId) + "-desktop"; }
    private static string CleanupTaskName(string requestId) { return BaseTaskName(requestId) + "-cleanup"; }

    private static void CleanupTasks(string requestId) {
      DeleteTask(WorkerTaskName(requestId));
      DeleteTask(DesktopTaskName(requestId));
      DeleteTask(CleanupTaskName(requestId));
    }

    private static int Schedule(string ticketPath) {
      Dictionary<string, object> ticket = ReadTicket(ticketPath);
      if (Text(ticket, "phase") != "armed" || Number(ticket, "expiresAt") <= UtcMs())
        return Fail("restart-ticket-not-armed", 20);
      string name = WorkerTaskName(Text(ticket, "requestId"));
      if (TaskExists(name)) return Fail("restart-task-already-exists", 21);
      try {
        // Match the running Desktop's actual Windows token elevation.
        // The Host already has to possess this privilege; there is no UAC
        // prompt and no privilege escalation beyond the target Desktop.
        DesktopProcess target = GetDesktopMain(Text(ticket, "exePath"));
        if (target.Pid != Number(ticket, "oldMainPid"))
          throw new InvalidOperationException("desktop-main-changed");
        int runLevel = IsProcessElevated(target.Pid) ? 1 : 0;
        Put(ticket, "oldMainElevated", runLevel);
        WriteTicket(ticketPath, ticket);
        RegisterTask(name, HelperPath, "--execute \"" + ticketPath + "\"",
          null, "PT5M", true, runLevel);
        DateTime deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline) {
          Dictionary<string, object> current = ReadTicket(ticketPath);
          if (Text(current, "requestId") != Text(ticket, "requestId"))
            throw new InvalidOperationException("restart-ticket-replaced");
          string phase = Text(current, "phase");
          if (phase == "executing" || phase == "restarted" || phase == "notified") {
            Output(new Dictionary<string, object> { { "workerStarted", true } });
            return 0;
          }
          if (phase == "failed" || phase == "cancelled" || phase == "timed-out")
            throw new InvalidOperationException("restart-worker-failed");
          Thread.Sleep(200);
        }
        throw new InvalidOperationException("restart-worker-timeout");
      } catch {
        try {
          Dictionary<string, object> current = ReadTicket(ticketPath);
          if (Text(current, "requestId") == Text(ticket, "requestId") && Text(current, "phase") == "armed") {
            Put(current, "phase", "failed");
            Put(current, "failureCode", "restart-worker-not-started");
            Put(current, "finishedAt", UtcMs());
            WriteTicket(ticketPath, current);
          }
        } catch { }
        try { if (TaskExists(name)) DeleteTask(name); } catch { }
        return Fail("restart-worker-not-started", 22);
      }
    }

    private static bool IsOldProcessAlive(int pid, string exePath) {
      DesktopProcess item = GetProcess(pid);
      return item != null && String.Equals(item.Path, exePath, StringComparison.OrdinalIgnoreCase);
    }

    private static void StopDesktopTree(List<DesktopProcess> tree, string exePath) {
      foreach (DesktopProcess entry in tree) {
        // Renderer/utility children can exit spontaneously during a shutdown.
        // Only ignore a termination race if the exact old executable PID is
        // no longer alive; an access-denied error must always remain fatal.
        DesktopProcess current = GetProcess(entry.Pid);
        if (current == null) continue;
        if (!String.Equals(current.Path, exePath, StringComparison.OrdinalIgnoreCase)
          || current.ParentPid != entry.ParentPid)
          throw new InvalidOperationException("desktop-process-changed");
        try {
          using (Process process = Process.GetProcessById(entry.Pid)) {
            if (process.HasExited) continue;
            process.Kill();
            if (!process.WaitForExit(10000) && IsOldProcessAlive(entry.Pid, exePath))
              throw new InvalidOperationException("desktop-process-stop-timeout");
          }
        } catch (ArgumentException) {
          if (IsOldProcessAlive(entry.Pid, exePath))
            throw new InvalidOperationException("desktop-process-stop-race");
        } catch (InvalidOperationException) {
          if (IsOldProcessAlive(entry.Pid, exePath)) throw;
        } catch (System.ComponentModel.Win32Exception) {
          if (IsOldProcessAlive(entry.Pid, exePath))
            throw new InvalidOperationException("desktop-process-stop-denied");
        }
      }
      DateTime deadline = DateTime.UtcNow.AddSeconds(20);
      while (DateTime.UtcNow < deadline) {
        bool any = tree.Any(p => IsOldProcessAlive(p.Pid, exePath));
        if (!any) return;
        Thread.Sleep(200);
      }
      throw new InvalidOperationException("old-desktop-process-residue");
    }


    private static int WaitForStableNewMain(int oldPid, string exePath, int timeoutSeconds) {
      DateTime deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);
      int candidatePid = 0;
      DateTime stableSince = DateTime.MinValue;
      while (DateTime.UtcNow < deadline) {
        List<DesktopProcess> all = GetDesktopProcesses(exePath);
        List<DesktopProcess> roots = GetRoots(all);
        if (roots.Count > 1) throw new InvalidOperationException("multiple-desktop-roots-after-restart");
        if (roots.Count == 1 && roots[0].Pid != oldPid
          && String.Equals(roots[0].Path, exePath, StringComparison.OrdinalIgnoreCase)) {
          if (candidatePid != roots[0].Pid) {
            candidatePid = roots[0].Pid;
            stableSince = DateTime.UtcNow;
          } else if ((DateTime.UtcNow - stableSince).TotalSeconds >= 8) {
            return candidatePid;
          }
        } else {
          candidatePid = 0;
          stableSince = DateTime.MinValue;
        }
        Thread.Sleep(500);
      }
      throw new InvalidOperationException("desktop-new-main-not-stable");
    }

    private static int LaunchOrReuseDesktop(Dictionary<string, object> ticket, out int newPid) {
      int oldPid = Convert.ToInt32(Number(ticket, "oldMainPid"));
      string exePath = Text(ticket, "exePath");
      newPid = 0;
      DateTime relaunchDeadline = DateTime.UtcNow.AddSeconds(3);
      while (DateTime.UtcNow < relaunchDeadline) {
        try {
          DesktopProcess main = GetDesktopMain(exePath);
          if (main.Pid != oldPid && String.Equals(main.Path, exePath, StringComparison.OrdinalIgnoreCase)) {
            newPid = WaitForStableNewMain(oldPid, exePath, 90);
            return 0;
          }
        } catch (InvalidOperationException error) {
          if (error.Message == "multiple-desktop-roots-after-restart") throw;
        }
        Thread.Sleep(300);
      }
      string requestId = Text(ticket, "requestId");
      string cleanupName = CleanupTaskName(requestId);
      string desktopName = DesktopTaskName(requestId);
      if (!TaskExists(cleanupName)) {
        RegisterTask(cleanupName, HelperPath, "--cleanup " + requestId,
          DateTime.Now.AddMinutes(3), "PT30S", false, (int)Number(ticket, "oldMainElevated"));
      }
      if (!TaskExists(desktopName)) {
        RegisterTask(desktopName, exePath, "", null, "PT0S", true,
          (int)Number(ticket, "oldMainElevated"));
      } else {
        RunTask(desktopName);
      }
      newPid = WaitForStableNewMain(oldPid, exePath, 90);
      return 0;
    }

    private static int Execute(string ticketPath) {
      Dictionary<string, object> ticket = null;
      string requestId = "";
      try {
        ticket = ReadTicket(ticketPath);
        if (Text(ticket, "phase") != "armed" || Number(ticket, "expiresAt") <= UtcMs()
          || Number(ticket, "oldMainPid") <= 0)
          throw new InvalidOperationException("restart-ticket-not-armed");
        requestId = Text(ticket, "requestId");
        DesktopProcess original = GetDesktopMain(Text(ticket, "exePath"));
        if (original.Pid != Number(ticket, "oldMainPid")
          || !String.Equals(original.Path, Text(ticket, "exePath"), StringComparison.OrdinalIgnoreCase))
          throw new InvalidOperationException("desktop-process-changed");
        if (IsProcessElevated(original.Pid) && !IsProcessElevated(Process.GetCurrentProcess().Id))
          throw new InvalidOperationException("desktop-worker-elevation-mismatch");
        Put(ticket, "phase", "executing");
        Put(ticket, "workerPid", Process.GetCurrentProcess().Id);
        Put(ticket, "workerStartedAt", UtcMs());
        WriteTicket(ticketPath, ticket);
        Thread.Sleep(1500);
        ticket = ReadTicket(ticketPath);
        if (Text(ticket, "phase") != "executing" || Number(ticket, "expiresAt") <= UtcMs())
          throw new InvalidOperationException("restart-request-cancelled");
        original = GetDesktopMain(Text(ticket, "exePath"));
        if (original.Pid != Number(ticket, "oldMainPid")) throw new InvalidOperationException("desktop-process-changed");
        List<DesktopProcess> tree = GetDesktopTree(original.Pid, original.Path);
        Put(ticket, "oldTreePids", tree.Select(p => p.Pid).ToArray());
        WriteTicket(ticketPath, ticket);
        StopDesktopTree(tree, original.Path);
        int newPid;
        LaunchOrReuseDesktop(ticket, out newPid);
        ticket = ReadTicket(ticketPath);
        if (Text(ticket, "phase") != "executing") throw new InvalidOperationException("restart-ticket-replaced");
        Put(ticket, "phase", "restarted");
        Put(ticket, "newMainPid", newPid);
        Put(ticket, "finishedAt", UtcMs());
        WriteTicket(ticketPath, ticket);
        DeleteTask(WorkerTaskName(requestId));
        return 0;
      } catch (Exception error) {
        if (ticket != null) RecoverAfterFailure(ticketPath, ticket, requestId, error);
        return 30;
      }
    }

    private static string SafeRestartFailureCode(Exception error) {
      string text = error is InvalidOperationException ? error.Message : "";
      if (text.StartsWith("desktop-", StringComparison.Ordinal)
        && text.Length <= 64 && text.All(c => (c >= 'a' && c <= 'z') || c == '-'))
        return text;
      return "desktop-restart-failed";
    }

    private static void RecoverAfterFailure(string ticketPath, Dictionary<string, object> ticket,
      string requestId, Exception error) {
      try {
        Dictionary<string, object> current = ReadTicket(ticketPath);
        if (Text(current, "requestId") != Text(ticket, "requestId")) return;
        if (Text(current, "phase") == "notified") return;
        int oldPid = Convert.ToInt32(Number(current, "oldMainPid"));
        string exePath = Text(current, "exePath");
        if (IsOldProcessAlive(oldPid, exePath)) {
          Put(current, "phase", "failed");
          Put(current, "failureCode", SafeRestartFailureCode(error));
          Put(current, "finishedAt", UtcMs());
          WriteTicket(ticketPath, current);
          CleanupTasks(requestId);
        } else {
          int replacement;
          LaunchOrReuseDesktop(current, out replacement);
          Put(current, "phase", "restarted");
          Put(current, "newMainPid", replacement);
          Put(current, "finishedAt", UtcMs());
          Put(current, "failureCode", "restart-worker-recovered");
          WriteTicket(ticketPath, current);
          DeleteTask(WorkerTaskName(requestId));
        }
      } catch {
        try { CleanupTasks(requestId); } catch { }
        try {
          Dictionary<string, object> current = ReadTicket(ticketPath);
          Put(current, "phase", "failed");
          Put(current, "failureCode", "desktop-restart-recovery-failed");
          Put(current, "finishedAt", UtcMs());
          WriteTicket(ticketPath, current);
        } catch { }
      }
    }

    private static int CheckClean(string ticketPath) {
      try {
        Dictionary<string, object> ticket = ReadTicket(ticketPath);
        string phase = Text(ticket, "phase");
        if (phase != "restarted" && phase != "notified") return Fail("restart-not-finished", 31);
        DesktopProcess main = GetDesktopMain(Text(ticket, "exePath"));
        if (main.Pid != Number(ticket, "newMainPid") || main.Pid == Number(ticket, "oldMainPid")
          || !String.Equals(main.Path, Text(ticket, "exePath"), StringComparison.OrdinalIgnoreCase))
          return Fail("desktop-main-mismatch", 32);
        object pids;
        if (ticket.TryGetValue("oldTreePids", out pids) && pids is IEnumerable) {
          foreach (object value in (IEnumerable)pids) {
            int pid = Convert.ToInt32(value);
            if (IsOldProcessAlive(pid, Text(ticket, "exePath"))) return Fail("old-desktop-process-residue", 33);
          }
        } else if (IsOldProcessAlive(Convert.ToInt32(Number(ticket, "oldMainPid")), Text(ticket, "exePath"))) {
          return Fail("old-desktop-process-residue", 33);
        }
        int workerPid = Convert.ToInt32(Number(ticket, "workerPid"));
        DesktopProcess worker = workerPid > 0 ? GetProcess(workerPid) : null;
        if (worker != null && String.Equals(worker.Path, HelperPath, StringComparison.OrdinalIgnoreCase))
          return Fail("restart-worker-residue", 35);
        CleanupTasks(Text(ticket, "requestId"));
        DesktopProcess afterCleanup = GetDesktopMain(Text(ticket, "exePath"));
        if (afterCleanup.Pid != main.Pid) return Fail("desktop-stopped-during-task-cleanup", 36);
        if (TaskExists(WorkerTaskName(Text(ticket, "requestId")))
          || TaskExists(DesktopTaskName(Text(ticket, "requestId")))
          || TaskExists(CleanupTaskName(Text(ticket, "requestId"))))
          return Fail("restart-task-residue", 34);
        Output(new Dictionary<string, object> { { "clean", true }, { "rootPid", main.Pid } });
        return 0;
      } catch {
        return Fail("restart-clean-check-failed", 37);
      }
    }

    private static int Cleanup(string requestId) {
      try {
        CleanupTasks(requestId);
        Output(new Dictionary<string, object> { { "cleaned", true } });
        return 0;
      } catch {
        return Fail("restart-task-cleanup-failed", 50);
      }
    }

    private static int ProbeTask(string marker, int runLevel) {
      if (!Path.IsPathRooted(marker) || marker.IndexOf('"') >= 0) return Fail("invalid-probe-path", 40);
      string name = "DSHWechatRestartProbe-" + Guid.NewGuid().ToString("N");
      string start = marker + ".start";
      string end = marker + ".end";
      try {
        foreach (string path in new string[] { marker, start, end, marker + ".self-start", marker + ".self-end", marker + ".error" }) if (File.Exists(path)) File.Delete(path);
        RegisterTask(name, HelperPath, "--probe-long \"" + marker + "\" \"" + name + "\"", null, "PT10S", true, runLevel);
        DateTime startDeadline = DateTime.UtcNow.AddSeconds(10);
        while (DateTime.UtcNow < startDeadline && !File.Exists(start)) Thread.Sleep(100);
        if (!File.Exists(start)) return Fail("probe-action-not-started", 41);
        if (runLevel == 1 && !File.ReadAllText(start).Contains("elevated=true"))
          return Fail("probe-worker-not-elevated", 48);
        DeleteTask(name);
        DateTime endDeadline = DateTime.UtcNow.AddSeconds(10);
        while (DateTime.UtcNow < endDeadline && !File.Exists(end)) Thread.Sleep(100);
        if (!File.Exists(end)) return Fail("probe-action-killed-by-task-delete", 42);
        if (TaskExists(name)) return Fail("probe-task-residue", 43);
        string selfName = name + "-self";
        RegisterTask(selfName, HelperPath, "--probe-self-delete \"" + marker + "\" \"" + selfName + "\"",
          null, "PT10S", true);
        DateTime selfDeadline = DateTime.UtcNow.AddSeconds(10);
        while (DateTime.UtcNow < selfDeadline && !File.Exists(marker + ".self-end")) Thread.Sleep(100);
        if (!File.Exists(marker + ".self-end") || TaskExists(selfName))
          return Fail("probe-self-delete-failed", 46);
        Output(new Dictionary<string, object> {
          { "runningActionSurvivedTaskDelete", true },
          { "runningActionSurvivedSelfDelete", true },
          { "taskRemoved", true }
        });
        return 0;
      } catch (Exception error) {
        try { File.WriteAllText(marker + ".error", error.GetType().FullName + ":" + error.Message + " | " + error.StackTrace); } catch { }
        return Fail("probe-task-failed", 44);
      } finally {
        try { DeleteTask(name); } catch { }
        try { DeleteTask(name + "-self"); } catch { }
        foreach (string path in new string[] { marker, start, end, marker + ".self-start", marker + ".self-end", marker + ".error" }) {
          try { if (File.Exists(path)) File.Delete(path); } catch { }
        }
      }
    }

    private static int ProbeSelfDelete(string marker, string taskName) {
      try {
        File.WriteAllText(marker + ".self-start", Process.GetCurrentProcess().Id.ToString());
        DeleteTask(taskName);
        File.WriteAllText(marker + ".self-end", "survived-self-delete");
        return 0;
      } catch { return 47; }
    }

    private static int ProbeLong(string marker, string taskName) {
      try {
        File.WriteAllText(marker + ".start", Process.GetCurrentProcess().Id
          + ";elevated=" + (IsProcessElevated(Process.GetCurrentProcess().Id) ? "true" : "false"));
        Thread.Sleep(3500);
        File.WriteAllText(marker + ".end", "survived-task-delete");
        return 0;
      } catch { return 45; }
    }
  }
}