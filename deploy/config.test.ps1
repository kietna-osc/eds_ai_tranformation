# Test environment. Shares the resource group and the APIM instance with dev;
# every other resource is its own, named with "test". Read by setup-test.ps1
# and deploy-test.ps1.
@{
    Name           = 'test'
    SubscriptionId = '4f338a7a-f335-4d6a-9c7e-c0a53475f408'   # SUB-D1-EDS-DEV
    ResourceGroup  = 'rg-kietna-1422'
    Location       = 'centralus'

    FunctionApp = @{
        Name           = 'func-eds-test'
        RuntimeStorage = 'stedstest1013'    # the Functions host's own storage and deployment packages
        PlanType       = 'Consumption'      # Linux Consumption, as dev ('FlexConsumption' also supported)
        # Azure does not let this subscription create App Service plans in Central US
        # ("not allowed to create or update the serverfarm"), so the app runs in East US,
        # next to apim-eds-dev. Its storage and database stay in Central US.
        Location       = 'eastus'
        NodeVersion    = '22'
        Settings = [ordered]@{
            SQL_SERVER            = 'sql-eds-test1.database.windows.net'
            SQL_DATABASE          = 'eds-db-test'
            BLOB_ACCOUNT_URL      = 'https://stedsimagestest1013.blob.core.windows.net'
            BLOB_CONTAINER        = 'history-images'
            BLOB_EXPORT_CONTAINER = 'history-exports'
            BLOB_SAS_MINUTES      = '60'
            BLOB_PREVIEW_WIDTH    = '320'
        }
    }

    ImageStorage = @{ Name = 'stedsimagestest1013'; Containers = @('history-images', 'history-exports') }

    # Created as a free-offer database with the same configuration as dev's eds-db,
    # then filled with eds-db's schema and data.
    Sql = @{
        ServerName  = 'sql-eds-test1'
        Database    = 'eds-db-test'
        Edition     = 'GeneralPurpose'   # serverless Gen5, max 2 / min 0.5 vCores: GP_S_Gen5_2, as dev
        Family      = 'Gen5'
        MaxVcores   = '2'
        MinVcores   = '0.5'
        AutoPauseMinutes = '60'
        MaxSize     = '32GB'
        BackupRedundancy = 'Local'
        Collation   = 'SQL_Latin1_General_CP1_CI_AS'
        FreeOffer   = $true              # 100,000 vCore-seconds a month; pauses (no charge) when used up
    }

    SqlTokens = [ordered]@{
        FUNC_APP         = 'func-eds-test'
        BLOB_ACCOUNT_URL = 'https://stedsimagestest1013.blob.core.windows.net'
    }
    # Literal replacements applied to every SQL script before it runs here, for
    # scripts that name dev's resources directly instead of using $(FUNC_APP) etc.
    SqlReplace = [ordered]@{
        'https://stedsimages1008.blob.core.windows.net' = 'https://stedsimagestest1013.blob.core.windows.net'
        'func-eds-dev'                                  = 'func-eds-test'
    }

    Apim = @{
        Name              = 'apim-eds-dev'           # shared with dev
        ApiId             = 'eds-data-api-test'
        Path              = 'eds-test'
        DisplayName       = 'EDS Data API (test)'
        ServiceUrl        = 'https://func-eds-test.azurewebsites.net/api'
        UrlNamedValue     = 'func-eds-test-url'
        KeyNamedValue     = 'func-eds-test-key'
        ManageNamedValues = $true                    # set from func-eds-test's host key on every deploy
        RateLimitPrefix   = 'test-'                  # own rate-limit counter, separate from dev's
    }

    # What setup-test.ps1 copies from dev.
    Source = @{
        SqlServer      = 'sql-eds-dev1'
        Database       = 'eds-db'
        FunctionApp    = 'func-eds-dev'                 # its database user is replaced by func-eds-test's
        ImageStorage   = 'stedsimages1008'
        ImageContainer = 'history-images'
    }

    PowerPlatform = @{
        SourceEnvironment = 'https://org09638faf.crm5.dynamics.com/'   # smartosc.com (default) = dev
        TargetEnvironment = 'https://org41314255.crm7.dynamics.com/'   # EDS-test
        Solution          = 'EDSPADelivery'
        # Warned about when missing from the solution: they are only deployed if they are in it.
        ExpectedComponents = @('EDS-App-Desktop-phase2', 'EDS-APIManagement1', 'EDS-EmployeeImport')
        # Text replaced in the exported flows and in the canvas app (.msapp) before import.
        # The flows and the app hold these IDs directly, not through environment variables.
        Replace = [ordered]@{
            # Function API behind APIM
            'https://apim-eds-dev.azure-api.net/eds/' = 'https://apim-eds-dev.azure-api.net/eds-test/'
            # SharePoint: Reception site -> Test-Reception site, and its Documents library
            'https://smartosc0.sharepoint.com/sites/Teamresponsibleforreceivingexpressshipments' = 'https://smartosc0.sharepoint.com/sites/Test-Reception'
            'f22c3b9e-916b-450c-9494-8645d34e6e92' = '27932a89-aa7b-4239-a408-acd17a1f3b94'
            # Teams: Notification / RnD -> Test-Notification / channel notification
            'ed66985f-fd47-43fe-aaa2-dc487369ac73' = 'c245a31d-364e-4c29-b981-7ef378afd058'
            '19:15c6dceff0ab43958bdf39603b821b69@thread.tacv2' = '19:8hBA_waepabkhb5eRli5pXMEXw2aRgtI1U0PqF63p3U1@thread.tacv2'
            # Planner: EDSProcessLabel / EDS-Planner -> Test-Notification / EDS-Planner-test (same 15 buckets)
            'c21aaf6b-d3d0-4af9-99dc-a4dbba9cc69b' = 'c245a31d-364e-4c29-b981-7ef378afd058'
            'yiKgz9mJbUmRxmNx_gKtg8kAAuHj' = '1PxMhy3aGEq9l9rwwq4B2ckAGA-B'
            # Not mapped, stays shared with dev: the EDSProcessLabel2 site (PackageSlipLog,
            # EmployeeList, UnknownImage, UploadedImage); the current app barely uses it.
        }
        # Environment variable values for EDS-test. A variable not listed keeps the value
        # it has in dev's solution, i.e. the dev SharePoint lists, Teams channel and Planner
        # plan. Add the test values here once test has its own.
        EnvironmentVariables = [ordered]@{
            cr1d7_SharepointSite = 'https://smartosc0.sharepoint.com/sites/EDSProcessLabel2'   # TODO: test site
        }
        # Connection IDs in EDS-test, only for connection references that have no connection there yet.
        ConnectionIds = @{}
    }
}
