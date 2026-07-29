// 首次启动引导（SPEC-002）。
// 扫描本机 CLI → 友好呈现已装/缺失（安装动作 SPEC-010 后续补）→ 进入工作台。

import { useEffect, useState } from 'react'
import { useToolsStore } from '../stores/toolsStore'
import { useUiStore } from '../stores/uiStore'
import { healthColor, healthLabel } from '../lib/status'
import { useT } from '../lib/i18n'
import agentOsLogo from '../assets/agentos-logo.png'
import { trackOnboardingCompleted } from '../analytics/mixpanel'
import './OnboardingView.css'

export function OnboardingView({
  onComplete
}: {
  onComplete?: () => void
} = {}): React.JSX.Element {
  const { results, scanning, scanError, scan } = useToolsStore()
  const setOnboardingCompleted = useUiStore((s) => s.setOnboardingCompleted)
  const { t } = useT()
  const [completing, setCompleting] = useState(false)
  const [completeError, setCompleteError] = useState<string | null>(null)
  const [step, setStep] = useState(0)
  const totalSteps = 6

  useEffect(() => {
    void scan()
  }, [scan])

  const found = results.filter((tool) => tool.health !== 'missing')
  const missing = results.filter((tool) => tool.health === 'missing')

  const complete = async (): Promise<void> => {
    setCompleting(true)
    setCompleteError(null)
    try {
      await window.agentOs.app.completeOnboarding()
      trackOnboardingCompleted(found.length)
      setOnboardingCompleted(true)
      onComplete?.()
    } catch (error) {
      setCompleteError(error instanceof Error ? error.message : String(error))
    } finally {
      setCompleting(false)
    }
  }

  return (
    <div className="onboarding">
      <div className="onboarding__card">
        <h1 className="onboarding__title">
          <img className="onboarding__brand-mark" src={agentOsLogo} alt="" aria-hidden="true" />
          {t('channels.onboarding.title')}
        </h1>
        <div
          className="onboarding__progress"
          aria-label={t('channels.onboarding.progress', { current: step + 1, total: totalSteps })}
        >
          <span>{t('channels.onboarding.progress', { current: step + 1, total: totalSteps })}</span>
          <div>
            {Array.from({ length: totalSteps }, (_, index) => (
              <i key={index} className={index <= step ? 'is-active' : ''} />
            ))}
          </div>
        </div>

        {step === 0 && (
          <GuideStep
            title={t('channels.onboarding.welcomeTitle')}
            desc={t('channels.onboarding.welcomeDesc')}
          >
            <GuideItems
              items={[
                t('channels.onboarding.agentChat'),
                t('channels.onboarding.automationSchedule'),
                t('channels.onboarding.connectRemote')
              ]}
            />
          </GuideStep>
        )}

        {step === 1 && (
          <div className="onboarding__section">
            <h2 className="onboarding__step-title">{t('channels.onboarding.cliStepTitle')}</h2>
            <p className="onboarding__step-desc">{t('channels.onboarding.cliStepDesc')}</p>
            <div className="onboarding__section-head">
              <span>{t('channels.onboarding.localCli')}</span>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => void scan()}
                disabled={scanning}
              >
                {scanning ? t('channels.onboarding.scanning') : t('channels.onboarding.rescan')}
              </button>
            </div>

            {scanError ? (
              <p className="onboarding__error" role="alert">
                {t('channels.onboarding.scanFailed', { error: scanError })}
              </p>
            ) : scanning && results.length === 0 ? (
              <p className="onboarding__hint">{t('channels.onboarding.scanHint')}</p>
            ) : results.length === 0 ? (
              <p className="onboarding__hint">{t('channels.onboarding.noCliFound')}</p>
            ) : (
              <>
                {found.length > 0 && (
                  <ul className="onboarding__list">
                    {found.map((tool) => (
                      <li key={tool.toolId} className="onboarding__tool">
                        <span
                          className="onboarding__dot"
                          style={{ background: healthColor(tool.health) }}
                        />
                        <span className="onboarding__tool-name">{tool.displayName}</span>
                        <span className="onboarding__tool-meta mono">
                          {healthLabel(tool.health)}
                          {tool.version ? ` · ${tool.version}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {missing.length > 0 && (
                  <div className="onboarding__missing">
                    <span className="onboarding__hint">
                      {t('channels.onboarding.missingLabel')}
                    </span>
                    {missing.map((tool) => (
                      <span key={tool.toolId} className="onboarding__missing-chip">
                        {tool.displayName}
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {step === 2 && (
          <GuideStep
            title={t('channels.onboarding.agentStepTitle')}
            desc={t('channels.onboarding.agentStepDesc')}
          >
            <GuideItems
              items={[t('channels.onboarding.agentChat'), t('channels.onboarding.agentCli')]}
            />
          </GuideStep>
        )}
        {step === 3 && (
          <GuideStep
            title={t('channels.onboarding.automationTitle')}
            desc={t('channels.onboarding.automationDesc')}
          >
            <GuideItems
              items={[
                t('channels.onboarding.automationSchedule'),
                t('channels.onboarding.automationReview')
              ]}
            />
          </GuideStep>
        )}
        {step === 4 && (
          <GuideStep
            title={t('channels.onboarding.connectTitle')}
            desc={t('channels.onboarding.connectDesc')}
          >
            <GuideItems
              items={[
                t('channels.onboarding.connectRemote'),
                t('channels.onboarding.connectChannel')
              ]}
            />
          </GuideStep>
        )}
        {step === 5 && (
          <GuideStep
            title={t('channels.onboarding.readyTitle')}
            desc={t('channels.onboarding.readyDesc')}
          >
            <GuideItems items={[t('channels.onboarding.readyTip')]} />
          </GuideStep>
        )}

        <div className="onboarding__actions">
          {completeError && (
            <span className="onboarding__error" role="alert">
              {t('channels.onboarding.enterFailed', { error: completeError })}
            </span>
          )}
          {step > 0 && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setStep((value) => value - 1)}
            >
              {t('channels.onboarding.back')}
            </button>
          )}
          {step < totalSteps - 1 ? (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setStep((value) => value + 1)}
            >
              {t('channels.onboarding.next')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              disabled={completing}
              onClick={() => void complete()}
            >
              {completing ? t('channels.onboarding.entering') : t('channels.onboarding.enter')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function GuideStep({
  title,
  desc,
  children
}: {
  title: string
  desc: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="onboarding__section onboarding__guide-step">
      <h2 className="onboarding__step-title">{title}</h2>
      <p className="onboarding__step-desc">{desc}</p>
      {children}
    </div>
  )
}

function GuideItems({ items }: { items: string[] }): React.JSX.Element {
  return (
    <ul className="onboarding__guide-items">
      {items.map((item) => (
        <li key={item}>
          <span>✓</span>
          {item}
        </li>
      ))}
    </ul>
  )
}
