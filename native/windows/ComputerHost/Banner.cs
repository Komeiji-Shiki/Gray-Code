using System;
using System.Drawing;
using System.Windows.Forms;

namespace GrayCode.ComputerHost {
  // 独立于模型与网页的可见停止入口，不取得键盘焦点。
  internal sealed class ControlBanner : Form {
    internal ControlBanner(Action stop) {
      Text="GrayCode · 正在操作电脑";FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;TopMost=true;
      StartPosition=FormStartPosition.Manual;Size=new Size(480,44);BackColor=Color.FromArgb(23,26,32);ForeColor=Color.White;
      var label=new Label {Text="GrayCode 正在操作电脑 · 移动鼠标或 Ctrl+Alt+Esc 接管",AutoSize=false,Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleLeft,Padding=new Padding(10,0,0,0)};
      var button=new Button {Text="停止",Dock=DockStyle.Right,Width=58,FlatStyle=FlatStyle.Flat,BackColor=Color.FromArgb(120,35,45)};
      button.Click+=delegate {stop();};Controls.Add(label);Controls.Add(button);
    }
    protected override bool ShowWithoutActivation {get{return true;}}
    protected override CreateParams CreateParams {get{var value=base.CreateParams;value.ExStyle|=0x08000000|0x00000080;return value;}}
    internal void Display() {var area=Screen.PrimaryScreen.WorkingArea;Location=new Point(Math.Max(area.Left,area.Right-Width-12),area.Top+12);Show();Win32.ShowWindow(Handle,4);}
  }
}
