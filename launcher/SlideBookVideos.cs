using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

// SlideBook Videos: the Videos window on its own. It runs SlideBook.exe --videos from the same folder, so both
// share one library (data\) and, when SlideBook is already open, one server.
static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string exe = Path.Combine(dir, "SlideBook.exe");
        if (!File.Exists(exe))
        {
            MessageBox.Show("SlideBook.exe must be in the same folder as SlideBookVideos.exe.", "SlideBook Videos",
                            MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        Process.Start(new ProcessStartInfo(exe, "--videos") { WorkingDirectory = dir, UseShellExecute = false });
        return 0;
    }
}
