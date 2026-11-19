param([string]$Text,[string]$Language,[string]$OutputPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Speech
$synth=New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  if ($Language -notin @('zh-CN','en-GB','en-US')) { throw 'Speech language unavailable' }
  $voice=$synth.GetInstalledVoices() | Where-Object {$_.Enabled -and $_.VoiceInfo.Culture.Name -eq $Language} | Select-Object -First 1
  if (-not $voice) { throw 'Speech language unavailable' }
  $synth.SelectVoice($voice.VoiceInfo.Name)
  $synth.Rate=-2
  $synth.SetOutputToWaveFile($OutputPath)
  $synth.Speak($Text)
} finally {$synth.Dispose()}
