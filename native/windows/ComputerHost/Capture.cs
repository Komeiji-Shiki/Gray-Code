using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

namespace GrayCode.ComputerHost {
  internal static class WindowCapture {
    // 系统文件对话框不一定出现在窗口共享目录中，前台窗口可以按实际物理区域采集。
    internal static object Visible(Observation observation,Dictionary<string,object> args) {
      DesktopWindows.RequireInteractive();DesktopWindows.Verify(observation.window,true);
      var bounds=observation.window.FrameBounds;var width=bounds.Right-bounds.Left;var height=bounds.Bottom-bounds.Top;
      var desktop=new Rectangle(Win32.GetSystemMetrics(76),Win32.GetSystemMetrics(77),Win32.GetSystemMetrics(78),Win32.GetSystemMetrics(79));
      if(width<1||height<1||(long)width*height>64000000||!desktop.Contains(new Rectangle(bounds.Left,bounds.Top,width,height)))
        throw new ComputerException("CAPTURE_BOUNDS_UNAVAILABLE","窗口没有完整显示在桌面区域内，请移动或缩小窗口后重新观察。");
      var maxWidth=Math.Max(320,Math.Min(2560,Json.Number(args,"width",1600)));var maxHeight=Math.Max(240,Math.Min(2160,Json.Number(args,"height",1200)));
      var factor=Math.Min(1,Math.Min((double)maxWidth/width,(double)maxHeight/height));var imageWidth=Math.Max(1,(int)Math.Round(width*factor));var imageHeight=Math.Max(1,(int)Math.Round(height*factor));
      using(var original=new Bitmap(width,height,PixelFormat.Format32bppArgb)) {
        using(var graphics=Graphics.FromImage(original))graphics.CopyFromScreen(bounds.Left,bounds.Top,0,0,new Size(width,height),CopyPixelOperation.SourceCopy);
        var capturedAt=Json.Now;
        using(var scaled=new Bitmap(imageWidth,imageHeight,PixelFormat.Format32bppArgb)) {
          using(var graphics=Graphics.FromImage(scaled)){graphics.InterpolationMode=InterpolationMode.HighQualityBicubic;graphics.DrawImage(original,new Rectangle(0,0,imageWidth,imageHeight));}
          using(var stream=new MemoryStream()) {
            scaled.Save(stream,ImageFormat.Png);DesktopWindows.Verify(observation.window,true);
            return new {capturedAt=capturedAt,windowId=observation.window.id,monitorId=observation.window.monitorId,dpi=observation.window.dpi,
              bounds=Json.Rect(bounds),width=imageWidth,height=imageHeight,mimeType="image/png",data=Convert.ToBase64String(stream.ToArray()),method="visible-screen-region"};
          }
        }
      }
    }
  }
}
